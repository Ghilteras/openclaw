import importlib.util
import io
import json
import sys
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path
from unittest import mock


DRIVER_PATH = Path(__file__).with_name("user-driver.py")
SPEC = importlib.util.spec_from_file_location("tg_user_driver_test_target", DRIVER_PATH)
driver = importlib.util.module_from_spec(SPEC)
sys.modules["tg_user_driver_test_target"] = driver
SPEC.loader.exec_module(driver)


class PhotoContentTest(unittest.TestCase):
    def inspect_private_chat(
        self,
        *,
        user_id=77,
        default_can_send=True,
        can_message_type="canSendMessageToUserResultOk",
        block_list=None,
    ):
        class FakeClient:
            def __init__(self):
                self.requests = []

            def request(self, payload, timeout=20):
                self.requests.append((payload, timeout))
                if payload["@type"] == "getChat":
                    return {
                        "type": {
                            "@type": "chatTypePrivate",
                            "user_id": user_id,
                        },
                        "permissions": {
                            "can_send_basic_messages": default_can_send,
                        },
                    }
                if payload["@type"] == "canSendMessageToUser":
                    return {"@type": can_message_type}
                if payload["@type"] == "getUserFullInfo":
                    return {"block_list": block_list}
                raise AssertionError(payload)

        instance = driver.UserDriver.__new__(driver.UserDriver)
        instance.client = FakeClient()
        result = instance.inspect_chat_writability(42)
        return result, instance.client.requests

    def test_rejects_unsafe_prebuilt_archive_members(self):
        class FakeTar:
            extracted = False

            def getmembers(self):
                return [driver.tarfile.TarInfo("../escape")]

            def extractall(self, _destination):
                self.extracted = True

        archive = FakeTar()
        with self.assertRaisesRegex(driver.DriverError, "unsafe member"):
            driver.extract_prebuilt_archive(archive, tempfile.mkdtemp())
        self.assertFalse(archive.extracted)

    def test_uses_current_tdlib_photo_shape(self):
        instance = driver.UserDriver.__new__(driver.UserDriver)
        instance.config = {}
        instance.bot_config = {}
        with tempfile.NamedTemporaryFile(suffix=".jpg") as photo:
            content = instance.photo_content(photo.name, "caption")

        self.assertEqual(content["@type"], "inputMessagePhoto")
        self.assertEqual(content["photo"]["@type"], "inputPhoto")
        self.assertEqual(content["photo"]["photo"]["@type"], "inputFileLocal")
        self.assertEqual(content["show_caption_above_media"], False)
        self.assertIsNone(content["self_destruct_type"])
        self.assertEqual(content["has_spoiler"], False)
        self.assertNotIn("ttl", content)

    def test_uses_test_dc_for_test_session(self):
        instance = driver.UserDriver.__new__(driver.UserDriver)
        instance.config = {
            "apiId": 123,
            "apiHash": "api-hash",
            "databaseEncryptionKey": "database-key",
            "testDc": True,
        }
        params = instance.td_params()
        self.assertEqual(params["parameters"]["use_test_dc"], True)
        current = instance.td_params_current()
        self.assertEqual(current["use_test_dc"], True)
        self.assertEqual(current["database_encryption_key"], "database-key")

    def test_refreshes_main_chat_list_for_a_new_numeric_chat(self):
        class FakeClient:
            def __init__(self):
                self.requests = []
                self.get_chat_calls = 0

            def request(self, payload, timeout=20):
                self.requests.append((payload, timeout))
                if payload["@type"] == "getChat":
                    self.get_chat_calls += 1
                    if self.get_chat_calls == 1:
                        raise driver.DriverError("getChat failed (400): Chat not found")
                    return {"id": -1001}
                return {"@type": "ok"}

        instance = driver.UserDriver.__new__(driver.UserDriver)
        instance.client = FakeClient()
        self.assertEqual(instance.resolve_chat("-1001"), -1001)
        self.assertEqual(
            [payload["@type"] for payload, _timeout in instance.client.requests],
            ["getChat", "loadChats", "getChat"],
        )

    def test_normalizes_named_chat_resolution_failures(self):
        class FakeClient:
            def request(self, payload, timeout=20):
                raise driver.DriverError(f"{payload['@type']} failed (400): not found")

        instance = driver.UserDriver.__new__(driver.UserDriver)
        instance.client = FakeClient()
        for chat in [
            "@missing",
            "https://t.me/missing",
            "https://t.me/+missing",
            "tg://join?invite=missing",
        ]:
            with self.subTest(chat=chat), self.assertRaises(
                driver.ChatResolutionError
            ):
                instance.resolve_chat(chat)

    def test_bad_named_chat_result(self):
        class FakeClient:
            def request(self, payload, timeout=20):
                return {"@type": "chat"}

        instance = driver.UserDriver.__new__(driver.UserDriver)
        instance.client = FakeClient()
        with self.assertRaises(driver.ChatResolutionError):
            instance.resolve_chat("@missing")

    def test_rejects_unsupported_chat_reference(self):
        instance = driver.UserDriver.__new__(driver.UserDriver)
        instance.client = object()
        with self.assertRaises(driver.ChatResolutionError):
            instance.resolve_chat("not-a-chat")

    def test_interprets_effective_chat_writability(self):
        default_allowed = {"can_send_basic_messages": True}
        default_denied = {"can_send_basic_messages": False}
        cases = [
            (
                "creator",
                {"@type": "chatMemberStatusCreator", "is_member": True},
                default_denied,
                True,
                True,
            ),
            (
                "detached creator",
                {"@type": "chatMemberStatusCreator", "is_member": False},
                default_allowed,
                False,
                False,
            ),
            (
                "administrator",
                {"@type": "chatMemberStatusAdministrator"},
                default_denied,
                True,
                True,
            ),
            ("member allowed", {"@type": "chatMemberStatusMember"}, default_allowed, True, True),
            (
                "member default denied",
                {"@type": "chatMemberStatusMember"},
                default_denied,
                True,
                False,
            ),
            (
                "restricted allowed",
                {
                    "@type": "chatMemberStatusRestricted",
                    "is_member": True,
                    "permissions": {"can_send_basic_messages": True},
                },
                default_allowed,
                True,
                True,
            ),
            (
                "restricted personally denied",
                {
                    "@type": "chatMemberStatusRestricted",
                    "is_member": True,
                    "permissions": {"can_send_basic_messages": False},
                },
                default_allowed,
                True,
                False,
            ),
            (
                "restricted default denied",
                {
                    "@type": "chatMemberStatusRestricted",
                    "is_member": True,
                    "permissions": {"can_send_basic_messages": True},
                },
                default_denied,
                True,
                False,
            ),
            (
                "restricted non-member",
                {
                    "@type": "chatMemberStatusRestricted",
                    "is_member": False,
                    "permissions": {"can_send_basic_messages": True},
                },
                default_allowed,
                False,
                False,
            ),
            ("left", {"@type": "chatMemberStatusLeft"}, default_allowed, False, False),
            ("banned", {"@type": "chatMemberStatusBanned"}, default_allowed, False, False),
            ("unknown", {"@type": "chatMemberStatusFuture"}, default_allowed, False, False),
            ("malformed", None, default_allowed, False, False),
        ]

        for name, status, permissions, expected_member, expected_writable in cases:
            with self.subTest(name=name):
                class FakeClient:
                    def request(self, payload, timeout=20):
                        if payload["@type"] == "getChat":
                            return {
                                "type": {
                                    "@type": "chatTypeSupergroup",
                                    "supergroup_id": 7,
                                    "is_channel": False,
                                },
                                "permissions": permissions,
                            }
                        return {"status": status}

                instance = driver.UserDriver.__new__(driver.UserDriver)
                instance.client = FakeClient()
                self.assertEqual(
                    instance.inspect_chat_writability(-1001),
                    {
                        "testerGroupMembership": expected_member,
                        "testerCanSendBasicMessages": expected_writable,
                    },
                )

    def test_supergroup_booster_bypasses_default_send_restriction(self):
        class FakeClient:
            def __init__(self):
                self.requests = []

            def request(self, payload, timeout=20):
                self.requests.append((payload, timeout))
                if payload["@type"] == "getChat":
                    return {
                        "type": {
                            "@type": "chatTypeSupergroup",
                            "supergroup_id": 7,
                            "is_channel": False,
                        },
                        "permissions": {"can_send_basic_messages": False},
                    }
                if payload["@type"] == "getSupergroup":
                    return {"status": {"@type": "chatMemberStatusMember"}}
                if payload["@type"] == "getSupergroupFullInfo":
                    return {
                        "my_boost_count": 2,
                        "unrestrict_boost_count": 2,
                    }
                raise AssertionError(payload)

        instance = driver.UserDriver.__new__(driver.UserDriver)
        instance.client = FakeClient()
        self.assertEqual(
            instance.inspect_chat_writability(-1001),
            {
                "testerGroupMembership": True,
                "testerCanSendBasicMessages": True,
            },
        )
        self.assertEqual(
            [payload["@type"] for payload, _timeout in instance.client.requests],
            ["getChat", "getSupergroup", "getSupergroupFullInfo"],
        )

    def test_supergroup_booster_still_respects_personal_restriction(self):
        class FakeClient:
            def request(self, payload, timeout=20):
                if payload["@type"] == "getChat":
                    return {
                        "type": {
                            "@type": "chatTypeSupergroup",
                            "supergroup_id": 7,
                            "is_channel": False,
                        },
                        "permissions": {"can_send_basic_messages": False},
                    }
                if payload["@type"] == "getSupergroup":
                    return {
                        "status": {
                            "@type": "chatMemberStatusRestricted",
                            "is_member": True,
                            "permissions": {"can_send_basic_messages": False},
                        }
                    }
                if payload["@type"] == "getSupergroupFullInfo":
                    return {
                        "my_boost_count": 3,
                        "unrestrict_boost_count": 2,
                    }
                raise AssertionError(payload)

        instance = driver.UserDriver.__new__(driver.UserDriver)
        instance.client = FakeClient()
        self.assertEqual(
            instance.inspect_chat_writability(-1001),
            {
                "testerGroupMembership": True,
                "testerCanSendBasicMessages": False,
            },
        )

    def test_allows_writable_private_chat_with_effective_capabilities(self):
        result, requests = self.inspect_private_chat()
        self.assertEqual(
            result,
            {
                "testerGroupMembership": True,
                "testerCanSendBasicMessages": True,
            },
        )
        self.assertEqual(
            requests,
            [
                ({"@type": "getChat", "chat_id": 42}, 10),
                (
                    {
                        "@type": "canSendMessageToUser",
                        "user_id": 77,
                        "only_local": False,
                    },
                    10,
                ),
                ({"@type": "getUserFullInfo", "user_id": 77}, 10),
            ],
        )

    def test_denies_read_only_private_chat(self):
        result, _requests = self.inspect_private_chat(default_can_send=False)
        self.assertEqual(
            result,
            {
                "testerGroupMembership": True,
                "testerCanSendBasicMessages": False,
            },
        )

    def test_denies_private_chat_blocked_on_main_list(self):
        result, _requests = self.inspect_private_chat(
            block_list={"@type": "blockListMain"}
        )
        self.assertEqual(
            result,
            {
                "testerGroupMembership": True,
                "testerCanSendBasicMessages": False,
            },
        )

    def test_denies_private_chat_for_cannot_message_results(self):
        for result_type in [
            "canSendMessageToUserResultUserHasPaidMessages",
            "canSendMessageToUserResultUserIsDeleted",
            "canSendMessageToUserResultUserRestrictsNewChats",
            "canSendMessageToUserResultFuture",
            None,
        ]:
            with self.subTest(result_type=result_type):
                result, _requests = self.inspect_private_chat(
                    can_message_type=result_type
                )
                self.assertEqual(
                    result,
                    {
                        "testerGroupMembership": True,
                        "testerCanSendBasicMessages": False,
                    },
                )

    def test_fails_closed_for_malformed_private_user_id(self):
        for user_id in [None, 0, -1, True, "77"]:
            with self.subTest(user_id=user_id):
                result, requests = self.inspect_private_chat(user_id=user_id)
                self.assertEqual(
                    result,
                    {
                        "testerGroupMembership": False,
                        "testerCanSendBasicMessages": False,
                    },
                )
                self.assertEqual(
                    requests,
                    [({"@type": "getChat", "chat_id": 42}, 10)],
                )

    def test_status_reports_unresolvable_chat_as_structured_health(self):
        class FakeClient:
            def request(self, payload, timeout=20):
                if payload["@type"] == "getMe":
                    return {
                        "id": 123,
                        "first_name": "QA",
                        "last_name": "User",
                        "username": "qa_user",
                        "type": {"@type": "userTypeRegular"},
                    }
                if payload == {"@type": "getOption", "name": "version"}:
                    return {"value": "1.8.67"}
                raise AssertionError(payload)

        class FakeDriver:
            client = FakeClient()

            def authorize(self, _args, need_ready=True):
                self.need_ready = need_ready
                return True

            def resolve_chat(self, _chat):
                raise driver.ChatResolutionError("Chat not found for tester account")

            def inspect_chat_writability(self, _chat_id):
                raise AssertionError("unresolvable chat must not be inspected")

        fake_driver = FakeDriver()
        args = driver.argparse.Namespace(
            timeout_ms=30_000,
            chat="-1001",
            json=True,
            output="",
        )
        stdout = io.StringIO()
        with (
            mock.patch.object(driver, "load_config", return_value=({"testDc": True}, {})),
            mock.patch.object(driver, "UserDriver", return_value=fake_driver),
            mock.patch.object(driver, "save_tester_identity"),
            redirect_stdout(stdout),
            self.assertRaises(SystemExit) as exit_context,
        ):
            driver.command_status(args)

        self.assertEqual(exit_context.exception.code, 1)
        self.assertFalse(fake_driver.need_ready)
        self.assertEqual(
            json.loads(stdout.getvalue()),
            {
                "authorized": True,
                "ok": False,
                "tdlibVersion": "1.8.67",
                "testDc": True,
                "testerCanSendBasicMessages": False,
                "testerGroupMembership": False,
                "user": {
                    "firstName": "QA",
                    "id": 123,
                    "isBot": False,
                    "lastName": "User",
                    "username": "qa_user",
                },
            },
        )

    def test_reads_current_user_status_from_basic_group(self):
        class FakeClient:
            def __init__(self):
                self.requests = []

            def request(self, payload, timeout=20):
                self.requests.append(payload)
                if payload["@type"] == "getChat":
                    return {
                        "type": {
                            "@type": "chatTypeBasicGroup",
                            "basic_group_id": 7,
                        },
                        "permissions": {"can_send_basic_messages": True},
                    }
                return {"status": {"@type": "chatMemberStatusMember"}}

        instance = driver.UserDriver.__new__(driver.UserDriver)
        instance.client = FakeClient()
        self.assertEqual(
            instance.inspect_chat_writability(-7),
            {
                "testerGroupMembership": True,
                "testerCanSendBasicMessages": True,
            },
        )
        self.assertEqual(
            instance.client.requests,
            [
                {"@type": "getChat", "chat_id": -7},
                {"@type": "getBasicGroup", "basic_group_id": 7},
            ],
        )

    def test_rejects_channel_targets_without_querying_membership(self):
        class FakeClient:
            def __init__(self):
                self.requests = []

            def request(self, payload, timeout=20):
                self.requests.append(payload["@type"])
                return {
                    "type": {
                        "@type": "chatTypeSupergroup",
                        "supergroup_id": 7,
                        "is_channel": True,
                    },
                    "permissions": {"can_send_basic_messages": True},
                }

        instance = driver.UserDriver.__new__(driver.UserDriver)
        instance.client = FakeClient()
        self.assertEqual(
            instance.inspect_chat_writability(-1001),
            {
                "testerGroupMembership": False,
                "testerCanSendBasicMessages": False,
            },
        )
        self.assertEqual(instance.client.requests, ["getChat"])
        with self.assertRaisesRegex(driver.DriverError, "cannot send basic messages"):
            instance.require_chat_writable(-1001)

    def test_fails_closed_for_malformed_supergroup_type(self):
        class FakeClient:
            def request(self, _payload, timeout=20):
                return {
                    "type": {
                        "@type": "chatTypeSupergroup",
                        "supergroup_id": 7,
                    },
                    "permissions": {"can_send_basic_messages": True},
                }

        instance = driver.UserDriver.__new__(driver.UserDriver)
        instance.client = FakeClient()
        self.assertEqual(
            instance.inspect_chat_writability(-1001),
            {
                "testerGroupMembership": False,
                "testerCanSendBasicMessages": False,
            },
        )

    def test_marks_sut_mentions_and_commands_with_utf16_entities(self):
        instance = driver.UserDriver.__new__(driver.UserDriver)
        instance.config = {"sutUsername": "sut_bot", "sutId": 101}
        instance.bot_config = {}
        formatted = instance.formatted_text("😀 @sut_bot hi /status@sut_bot")
        self.assertEqual(
            [entity["type"]["@type"] for entity in formatted["entities"]],
            ["textEntityTypeMention", "textEntityTypeBotCommand"],
        )
        self.assertEqual(formatted["entities"][0]["offset"], 3)
        self.assertEqual(formatted["entities"][0]["length"], 8)

    def test_normalizes_serve_messages_and_edits(self):
        known = {}
        message_id = 42 << 20
        text = "😀 a   b x"
        entities = [
            {"offset": 3, "length": 5, "type": {"@type": "textEntityTypeCode"}},
            {
                "offset": 9,
                "length": 1,
                "type": {"@type": "textEntityTypeTextUrl", "url": "https://example.com/qa"},
            },
        ]
        message = {
            "id": message_id,
            "chat_id": -1001,
            "sender_id": {"user_id": 101},
            "date": 123,
            "reply_to": {"message_id": 7},
            "content": {
                "@type": "messageText",
                "text": {"@type": "formattedText", "text": text, "entities": entities},
            },
        }
        users = {101: {"username": "sut_bot"}}
        created = driver.serve_update(
            {"@type": "updateNewMessage", "message": message}, users, known
        )
        self.assertEqual(created["kind"], "message")
        self.assertEqual(created["botApiMessageId"], 42)
        self.assertEqual(created["senderUsername"], "sut_bot")
        self.assertEqual(created["replyToMessageId"], 7)
        self.assertEqual(created["timestamp"], 123000)
        self.assertEqual(created["contentType"], "messageText")
        self.assertEqual(created["text"], text)
        self.assertEqual(created["entities"], entities)

        for edited_text, edited_entities in [
            (text, [{"offset": 3, "length": 5, "type": {"@type": "textEntityTypeBold"}}]),
            (text, []),
            ("final", [{"offset": 0, "length": 5, "type": {"@type": "textEntityTypePre"}}]),
        ]:
            with self.subTest(text=edited_text, entities=edited_entities):
                edited = driver.serve_update(
                    {
                        "@type": "updateMessageContent",
                        "chat_id": -1001,
                        "message_id": message_id,
                        "new_content": {
                            "@type": "messageText",
                            "text": {
                                "@type": "formattedText",
                                "text": edited_text,
                                "entities": edited_entities,
                            },
                        },
                    },
                    users,
                    known,
                )
                self.assertEqual(edited["kind"], "edit")
                self.assertEqual(edited["contentType"], "messageText")
                self.assertEqual(edited["text"], edited_text)
                self.assertEqual(edited["entities"], edited_entities)
                self.assertEqual(edited["senderId"], 101)
                self.assertEqual(known[message_id]["entities"], edited_entities)

    def test_preserves_native_content_type_and_caption_entities_in_messages_and_edits(self):
        entities = [{"offset": 3, "length": 5, "type": {"@type": "textEntityTypeCode"}}]
        message = {
            "id": 43 << 20,
            "chat_id": -1001,
            "sender_id": {"user_id": 101},
            "date": 123,
            "content": {
                "@type": "messagePhoto",
                "caption": {"@type": "formattedText", "text": "😀 a   b", "entities": entities},
            },
        }
        known = {}
        created = driver.serve_update(
            {"@type": "updateNewMessage", "message": message}, {}, known
        )
        normalized = driver.normalize_message(message)
        self.assertEqual(created["contentType"], "messagePhoto")
        self.assertEqual(created["text"], "😀 a   b")
        self.assertEqual(created["entities"], entities)
        self.assertEqual(normalized["entities"], entities)
        self.assertIs(normalized["raw"], message)
        edited = driver.serve_update(
            {
                "@type": "updateMessageContent",
                "message_id": message["id"],
                "new_content": {
                    "@type": "messageVideo",
                    "caption": {"@type": "formattedText", "text": "😀 a   b", "entities": []},
                },
            },
            {},
            known,
        )
        self.assertEqual(edited["contentType"], "messageVideo")
        self.assertEqual(known[message["id"]]["contentType"], "messageVideo")
        self.assertEqual(edited["text"], "😀 a   b")
        self.assertEqual(edited["entities"], [])

    def test_requires_explicit_entity_vectors_for_text_and_captions(self):
        for content_type, field in [("messageText", "text"), ("messagePhoto", "caption")]:
            for kind in ("message", "edit"):
                with self.subTest(content_type=content_type, kind=kind):
                    formatted = {"@type": "formattedText", "text": "plain", "entities": []}
                    content = {"@type": content_type, field: formatted}
                    message = {
                        "id": 44 << 20,
                        "chat_id": -1001,
                        "sender_id": {"user_id": 101},
                        "content": content,
                    }
                    known = {}
                    created = driver.serve_update(
                        {"@type": "updateNewMessage", "message": message}, {}, known
                    )
                    self.assertEqual(created["text"], "plain")
                    self.assertEqual(created["entities"], [])

                    del formatted["entities"]
                    update = (
                        {"@type": "updateNewMessage", "message": message}
                        if kind == "message"
                        else {
                            "@type": "updateMessageContent",
                            "chat_id": -1001,
                            "message_id": message["id"],
                            "new_content": content,
                        }
                    )
                    with self.assertRaisesRegex(KeyError, "entities"):
                        driver.serve_update(update, {}, known)
                    self.assertEqual(known[message["id"]]["entities"], [])

    def test_ignores_unknown_edit_in_serve_mode(self):
        event = driver.serve_update(
            {
                "@type": "updateMessageContent",
                "chat_id": -1001,
                "message_id": 99,
                "new_content": {},
            },
            {},
            {},
        )

        self.assertIsNone(event)


if __name__ == "__main__":
    unittest.main()
