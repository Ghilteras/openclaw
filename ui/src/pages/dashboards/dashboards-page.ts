import { consume } from "@lit/context";
import type { BoardSnapshot } from "@openclaw/gateway-protocol";
import type { PropertyValues } from "lit";
import { property, state } from "lit/decorators.js";
import { applicationContext, type ApplicationContext } from "../../app/context.ts";
import { formatUiError } from "../../lib/format-error.ts";
import { isGatewayMethodAdvertised } from "../../lib/gateway-methods.ts";
import { fetchPagedSessionRows } from "../../lib/sessions/paged-session-rows.ts";
import { OpenClawLightDomElement } from "../../lit/openclaw-element.ts";
import { SubscriptionsController } from "../../lit/subscriptions-controller.ts";
import type { DashboardPreviewLoader } from "./dashboard-preview.ts";
import {
  loadStoredDashboardsView,
  saveStoredDashboardsView,
  type DashboardsView,
} from "./page-state.ts";
import { dashboardSessionListQuery, dashboardsRouteData } from "./route.ts";
import {
  renderDashboards,
  type DashboardGalleryFilters,
  type DashboardsRouteData,
} from "./view.ts";

// Previews are keyed by session + row change marker, so a dashboard is fetched
// once per edit no matter how often the gallery re-renders or switches views.
// The bound keeps a long-lived tab from holding every snapshot it ever saw.
const PREVIEW_CACHE_LIMIT = 300;

type PreviewLoaderBinding = {
  client: NonNullable<ApplicationContext["gateway"]["snapshot"]["client"]>;
  load: DashboardPreviewLoader;
};

class DashboardsPage extends OpenClawLightDomElement {
  @consume({ context: applicationContext, subscribe: true })
  private context?: ApplicationContext;

  @property({ attribute: false }) routeData?: DashboardsRouteData;

  @state() private filters: DashboardGalleryFilters = {
    query: "",
    ownerId: "",
    sort: "updated",
  };
  @state() private view: DashboardsView = loadStoredDashboardsView();

  private observedSessions?: ApplicationContext["sessions"];
  private observedScopeId?: string | null;
  private unsubscribeList?: () => void;
  private data?: DashboardsRouteData;
  private listGeneration = 0;
  private previewCache = new Map<string, Promise<BoardSnapshot | null>>();
  private previewLoader?: PreviewLoaderBinding;
  private readonly subscriptions = new SubscriptionsController(this).effect(
    () => this.context?.agentSelection,
    (agentSelection) => {
      this.bindList();
      return agentSelection.subscribe(() => this.bindList());
    },
  );

  override disconnectedCallback() {
    this.listGeneration += 1;
    this.unsubscribeList?.();
    this.unsubscribeList = undefined;
    this.observedSessions = undefined;
    this.observedScopeId = undefined;
    this.subscriptions.clear();
    super.disconnectedCallback();
  }

  override willUpdate(changed: PropertyValues<this>) {
    if (changed.has("routeData")) {
      this.data = this.routeData;
    }
    this.bindList();
  }

  private bindList(): void {
    const context = this.context;
    if (!context) {
      return;
    }
    const sessions = context.sessions;
    const scopeId = context.agentSelection.state.scopeId?.trim() || null;
    if (sessions === this.observedSessions && scopeId === this.observedScopeId) {
      return;
    }
    this.unsubscribeList?.();
    this.observedSessions = sessions;
    this.observedScopeId = scopeId;
    const query = dashboardSessionListQuery(context);
    const apply = (snapshot: ReturnType<typeof sessions.listSnapshot>) => {
      if (
        this.context !== context ||
        this.observedSessions !== sessions ||
        this.observedScopeId !== scopeId ||
        (!snapshot.result && !snapshot.error)
      ) {
        return;
      }
      this.data = dashboardsRouteData(context, snapshot);
      this.requestUpdate();
      this.completeList(context, sessions, scopeId, query, snapshot);
    };
    this.unsubscribeList = sessions.subscribeList(query, apply);
    const snapshot = sessions.listSnapshot(query);
    apply(snapshot);
    if (!snapshot.result && !snapshot.loading && context.gateway.snapshot.phase === "connected") {
      void sessions.refreshList({ ...query, force: true });
    }
  }

  private completeList(
    context: ApplicationContext,
    sessions: ApplicationContext["sessions"],
    scopeId: string | null,
    query: ReturnType<typeof dashboardSessionListQuery>,
    snapshot: ReturnType<ApplicationContext["sessions"]["listSnapshot"]>,
  ): void {
    const initialResult = snapshot.result;
    const generation = ++this.listGeneration;
    if (!initialResult?.hasMore) {
      return;
    }
    const isCurrent = () =>
      this.context === context &&
      this.observedSessions === sessions &&
      this.observedScopeId === scopeId &&
      this.listGeneration === generation;
    void fetchPagedSessionRows({
      initialResult,
      list: (offset) => sessions.list({ ...query, offset }),
      isCurrent,
      missingResultError: "dashboard enumeration returned no result",
      stalledPaginationError: "dashboard enumeration did not advance",
      incompletePaginationError: "dashboard enumeration was incomplete",
    })
      .then((rows) => {
        if (!rows || !isCurrent()) {
          return;
        }
        this.data = dashboardsRouteData(context, {
          ...snapshot,
          result: {
            ...initialResult,
            count: rows.length,
            hasMore: false,
            nextOffset: null,
            sessions: rows,
          },
        });
        this.requestUpdate();
      })
      .catch((error: unknown) => {
        if (!isCurrent()) {
          return;
        }
        this.data = dashboardsRouteData(context, { ...snapshot, error: formatUiError(error) });
        this.requestUpdate();
      });
  }

  // One loader per gateway client: a stable identity keeps mounted previews from
  // refetching on every render, and a reconnect naturally rebinds it.
  private resolvePreviewLoader(): DashboardPreviewLoader | undefined {
    const snapshot = this.context?.gateway.snapshot;
    const client = snapshot?.client;
    if (!snapshot || !client || isGatewayMethodAdvertised(snapshot, "board.get") === false) {
      this.previewLoader = undefined;
      return undefined;
    }
    if (this.previewLoader?.client !== client) {
      this.previewLoader = {
        client,
        load: (request) => {
          const key = `${request.sessionKey}@${request.version}`;
          const cached = this.previewCache.get(key);
          if (cached) {
            return cached;
          }
          if (this.previewCache.size >= PREVIEW_CACHE_LIMIT) {
            this.previewCache.clear();
          }
          const pending = client
            .request<BoardSnapshot>("board.get", {
              sessionKey: request.sessionKey,
              ...(request.agentId ? { agentId: request.agentId } : {}),
            })
            .catch((): null => null);
          this.previewCache.set(key, pending);
          return pending;
        },
      };
    }
    return this.previewLoader.load;
  }

  override render() {
    return renderDashboards(
      this.data,
      () => {
        const context = this.context;
        if (context?.gateway.snapshot.phase === "connected") {
          void context.sessions.refreshList({ ...dashboardSessionListQuery(context), force: true });
        }
      },
      { filters: this.filters, view: this.view, loadPreview: this.resolvePreviewLoader() },
      {
        onQueryChange: (query) => {
          this.filters = { ...this.filters, query };
        },
        onOwnerChange: (ownerId) => {
          this.filters = { ...this.filters, ownerId };
        },
        onSortChange: (sort) => {
          this.filters = { ...this.filters, sort };
        },
        onViewChange: (view) => {
          this.view = view;
          saveStoredDashboardsView(view);
        },
      },
    );
  }
}

if (!customElements.get("openclaw-dashboards-page")) {
  customElements.define("openclaw-dashboards-page", DashboardsPage);
}
