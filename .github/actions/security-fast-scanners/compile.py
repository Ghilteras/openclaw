#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import os
import re
import tempfile
from pathlib import Path
from typing import Any

ROOT_KEYS = {
    "schemaVersion",
    "preCommitPackage",
    "zizmorConfigPath",
    "config",
    "scanners",
}
CONFIG_KEYS = {
    "minimum_pre_commit_version",
    "default_install_hook_types",
    "default_language_version",
    "default_stages",
    "files",
    "exclude",
    "fail_fast",
}
SCANNER_KEYS = {"package", "source", "hook"}
SOURCE_KEYS = {"repository", "revision"}
HOOK_KEYS = {
    "id",
    "name",
    "entry",
    "language",
    "alias",
    "files",
    "exclude",
    "types",
    "types_or",
    "exclude_types",
    "additional_dependencies",
    "args",
    "always_run",
    "fail_fast",
    "pass_filenames",
    "description",
    "language_version",
    "log_file",
    "minimum_pre_commit_version",
    "require_serial",
    "stages",
    "verbose",
}
STRING_HOOK_KEYS = {
    "id",
    "name",
    "entry",
    "language",
    "alias",
    "files",
    "exclude",
    "description",
    "language_version",
    "log_file",
    "minimum_pre_commit_version",
}
STRING_LIST_HOOK_KEYS = {
    "types",
    "types_or",
    "exclude_types",
    "additional_dependencies",
    "args",
    "stages",
}
BOOL_HOOK_KEYS = {
    "always_run",
    "fail_fast",
    "pass_filenames",
    "require_serial",
    "verbose",
}
PACKAGE_RE = re.compile(r"^[A-Za-z0-9_.-]+==[A-Za-z0-9_.+!-]+$")


def require_object(value: Any, label: str, keys: set[str]) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise ValueError(f"{label} must be an object")
    actual = set(value)
    if actual != keys:
        missing = sorted(keys - actual)
        extra = sorted(actual - keys)
        raise ValueError(f"{label} schema mismatch: missing={missing}, extra={extra}")
    return value


def require_string(value: Any, label: str) -> str:
    if not isinstance(value, str) or not value:
        raise ValueError(f"{label} must be a non-empty string")
    return value


def require_string_list(value: Any, label: str) -> list[str]:
    if not isinstance(value, list) or any(not isinstance(item, str) for item in value):
        raise ValueError(f"{label} must be a string array")
    return value


def require_package(value: Any, label: str) -> str:
    package = require_string(value, label)
    if not PACKAGE_RE.fullmatch(package):
        raise ValueError(f"{label} must be an exact package pin")
    return package


def validate_contract(raw: Any, trusted_zizmor_config: Path) -> tuple[dict[str, Any], str]:
    contract = require_object(raw, "contract", ROOT_KEYS)
    if contract["schemaVersion"] != 1:
        raise ValueError("contract schemaVersion must be 1")

    pre_commit_package = require_package(contract["preCommitPackage"], "preCommitPackage")
    zizmor_config_path = require_string(contract["zizmorConfigPath"], "zizmorConfigPath")
    config = require_object(contract["config"], "config", CONFIG_KEYS)
    require_string(config["minimum_pre_commit_version"], "config.minimum_pre_commit_version")
    require_string_list(config["default_install_hook_types"], "config.default_install_hook_types")
    if not isinstance(config["default_language_version"], dict):
        raise ValueError("config.default_language_version must be an object")
    require_string_list(config["default_stages"], "config.default_stages")
    if not isinstance(config["files"], str) or not isinstance(config["exclude"], str):
        raise ValueError("config files and exclude must be strings")
    if not isinstance(config["fail_fast"], bool):
        raise ValueError("config.fail_fast must be a boolean")

    scanners = contract["scanners"]
    if not isinstance(scanners, list) or not scanners:
        raise ValueError("scanners must be a non-empty array")

    packages = [pre_commit_package]
    hooks: list[dict[str, Any]] = []
    hook_ids: set[str] = set()
    zizmor_path_rewrites = 0
    for index, raw_scanner in enumerate(scanners):
        scanner = require_object(raw_scanner, f"scanners[{index}]", SCANNER_KEYS)
        packages.append(require_package(scanner["package"], f"scanners[{index}].package"))

        source = require_object(scanner["source"], f"scanners[{index}].source", SOURCE_KEYS)
        repository = require_string(source["repository"], f"scanners[{index}].source.repository")
        if not repository.startswith("https://github.com/"):
            raise ValueError(f"scanners[{index}].source.repository must be a GitHub HTTPS URL")
        require_string(source["revision"], f"scanners[{index}].source.revision")

        hook = require_object(scanner["hook"], f"scanners[{index}].hook", HOOK_KEYS)
        for key in STRING_HOOK_KEYS:
            if not isinstance(hook[key], str):
                raise ValueError(f"scanners[{index}].hook.{key} must be a string")
        for key in STRING_LIST_HOOK_KEYS:
            require_string_list(hook[key], f"scanners[{index}].hook.{key}")
        for key in BOOL_HOOK_KEYS:
            if not isinstance(hook[key], bool):
                raise ValueError(f"scanners[{index}].hook.{key} must be a boolean")
        if hook["language"] != "python":
            raise ValueError(f"scanners[{index}].hook.language must be python")
        if hook["language_version"] != "default":
            raise ValueError(f"scanners[{index}].hook.language_version must be default")
        if hook["additional_dependencies"]:
            raise ValueError(f"scanners[{index}].hook.additional_dependencies must be empty")

        hook_id = require_string(hook["id"], f"scanners[{index}].hook.id")
        if hook_id in hook_ids:
            raise ValueError(f"duplicate hook id: {hook_id}")
        hook_ids.add(hook_id)

        adapted_hook = dict(hook)
        adapted_hook["language"] = "system"
        adapted_args = []
        for argument in hook["args"]:
            if argument == zizmor_config_path:
                adapted_args.append(str(trusted_zizmor_config))
                zizmor_path_rewrites += 1
            else:
                adapted_args.append(argument)
        adapted_hook["args"] = adapted_args
        hooks.append(adapted_hook)

    package_names = [package.partition("==")[0].lower() for package in packages]
    if len(package_names) != len(set(package_names)):
        raise ValueError("package names must be unique")
    if zizmor_path_rewrites != 1:
        raise ValueError("trusted zizmor config path must appear exactly once")

    output_config = dict(config)
    output_config["repos"] = [{"repo": "local", "hooks": hooks}]
    requirements = "".join(f"{package}\n" for package in packages)
    return output_config, requirements


def write_atomic(path: Path, content: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(
        mode="w",
        encoding="utf-8",
        dir=path.parent,
        delete=False,
    ) as handle:
        handle.write(content)
        temporary = Path(handle.name)
    os.replace(temporary, path)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--contract", type=Path, required=True)
    parser.add_argument("--trusted-zizmor-config", type=Path, required=True)
    parser.add_argument("--output-config", type=Path, required=True)
    parser.add_argument("--output-requirements", type=Path, required=True)
    args = parser.parse_args()

    contract = json.loads(args.contract.read_text(encoding="utf-8"))
    output_config, requirements = validate_contract(contract, args.trusted_zizmor_config)
    write_atomic(args.output_config, json.dumps(output_config, indent=2) + "\n")
    write_atomic(args.output_requirements, requirements)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
