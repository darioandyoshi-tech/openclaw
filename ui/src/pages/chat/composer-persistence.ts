import type {
  ChatAttachment,
  ChatComposerDraftRetry,
  ChatGoalDraftMode,
} from "../../lib/chat/chat-types.ts";
import { nextDraftRevision } from "../../lib/chat/outbox-store-draft-state.ts";
import {
  resolveStoredChatOutboxScope,
  storedChatOutboxScopeKey,
  storageTargetForGateway,
  type StoredChatOutboxScope,
} from "../../lib/chat/outbox-store.ts";
import { hasUiSessionDefaults } from "../../lib/sessions/session-key.ts";
import { releaseChatAttachmentPayloads } from "./attachment-payload-store.ts";
import { normalizeChatComposerDraft } from "./composer-draft.ts";
import {
  loadComposerRevisions,
  loadChatComposerSnapshot,
  loadCapturedComposer,
  writeComposerState,
  writeComposerSnapshot,
  restoreChatComposerState,
  type ComposerPersistenceState,
  type ComposerRestoreOptions,
} from "./composer-session-store.ts";
import {
  captureDurableChatAttachments,
  chatAttachmentDraftSignature,
  DurableChatComposerPersistence,
  durableComposerScopeIdentity,
  type DurableChatComposerSnapshot,
} from "./durable-composer-persistence.ts";

const CHAT_COMPOSER_DRAFT_PERSIST_DELAY_MS = 200;
export const CHAT_COMPOSER_DRAFT_STORAGE_ERROR =
  "Could not store the previous draft in browser storage. It remains available in this tab.";

type DurableChatComposerPersistenceState = ComposerPersistenceState & {
  selectedChatSessionIncognito: boolean;
};

export type ChatComposerPersistResult =
  | { status: "persisted" }
  | { status: "conflict" }
  | ({ status: "storage-failed" } & ChatComposerDraftRetry);

type ChatComposerDraftSnapshot = {
  scope: StoredChatOutboxScope;
  awaitingDefaults: boolean;
  sessionKey: string;
  chatMessage: string;
  goalMode?: ChatGoalDraftMode;
  expectedDraftRevision: number;
  draftRevision: number;
  attachments: ChatAttachment[];
  durable?: DurableChatComposerSnapshot;
};

export class ChatComposerPersistence {
  private timer: ReturnType<typeof globalThis.setTimeout> | null = null;
  private ready = false;
  private pending: ChatComposerDraftSnapshot | null = null;
  private lastPersisted: ChatComposerDraftSnapshot | null = null;
  private committedDraftRevision = 0;
  private latestDraftRevision = 0;
  private durableRestoreProtected = false;
  // A transient disconnect invalidates scope readiness, not the owner authenticated
  // by this client. Client or Gateway replacement still fences the cached owner.
  private durableOwner: {
    client: ComposerPersistenceState["client"];
    gatewayOwner: string;
    recoveryScope: string;
  } | null = null;
  private durableRetiredScopeKey = "";
  private forceDurableOwnerRestore = false;
  private readonly durablePersistence = new DurableChatComposerPersistence(
    () => {
      const state = this.getState();
      if (!state) {
        return;
      }
      state.lastError = CHAT_COMPOSER_DRAFT_STORAGE_ERROR;
      state.chatError = CHAT_COMPOSER_DRAFT_STORAGE_ERROR;
      state.requestUpdate?.();
    },
    () => this.getState()?.requestUpdate?.(),
  );

  constructor(private readonly getState: () => DurableChatComposerPersistenceState | undefined) {}

  start() {
    const state = this.getState();
    if (!state) {
      return;
    }
    this.ready = true;
    this.pending = null;
    const revisions = this.readDraftRevisions(state);
    this.committedDraftRevision = revisions.committed;
    this.latestDraftRevision = revisions.latestAttempt;
    const stored = loadChatComposerSnapshot(state, state.sessionKey);
    this.durableRestoreProtected =
      (state.chatAttachments?.length ?? 0) > 0 ||
      (stored?.draft ?? "") !== state.chatMessage ||
      JSON.stringify(stored?.goalMode ?? null) !== JSON.stringify(state.chatGoalDraftMode ?? null);
    this.durablePersistence.resetRestoreScope();
    this.lastPersisted = this.snapshot(state, revisions.committed, revisions.committed);
    this.synchronizeDurablePersistence();
  }

  stop() {
    this.persistNow();
    this.ready = false;
    this.pending = null;
    this.clearTimer();
  }

  restore(options: ComposerRestoreOptions = {}): boolean {
    const state = this.getState();
    if (!state) {
      return false;
    }
    const restored = restoreChatComposerState(state, options);
    this.pending = null;
    this.clearTimer();
    const revisions = this.readDraftRevisions(state);
    this.committedDraftRevision = revisions.committed;
    this.latestDraftRevision = revisions.latestAttempt;
    this.lastPersisted = this.snapshot(state, revisions.committed, revisions.committed);
    this.durableRestoreProtected = false;
    this.durablePersistence.resetRestoreScope();
    return restored;
  }

  schedule() {
    const state = this.getState();
    if (!this.ready || !state) {
      return;
    }
    const current = this.snapshot(state);
    if (this.isUnchanged(current)) {
      if (!this.pending) {
        this.clearTimer();
        return;
      }
      if (
        chatAttachmentDraftSignature(
          this.pending.chatMessage,
          this.pending.attachments,
          this.pending.goalMode,
        ) ===
        chatAttachmentDraftSignature(current.chatMessage, current.attachments, current.goalMode)
      ) {
        this.clearTimer();
        this.timer = globalThis.setTimeout(
          () => this.persistNow(),
          CHAT_COMPOSER_DRAFT_PERSIST_DELAY_MS,
        );
        return;
      }
    }
    const baseline = Math.max(this.latestDraftRevision, this.pending?.draftRevision ?? 0);
    const draftRevision = nextDraftRevision(baseline);
    this.latestDraftRevision = draftRevision;
    this.pending = this.snapshot(state, draftRevision, this.committedDraftRevision);
    this.clearTimer();
    this.timer = globalThis.setTimeout(
      () => this.persistNow(),
      CHAT_COMPOSER_DRAFT_PERSIST_DELAY_MS,
    );
  }

  persistNow() {
    const state = this.getState();
    if (!this.ready || !state) {
      return;
    }
    let snapshot = this.pending;
    if (!snapshot) {
      const current = this.snapshot(state);
      if (this.isUnchanged(current)) {
        return;
      }
      snapshot = this.snapshot(
        state,
        nextDraftRevision(this.latestDraftRevision),
        this.committedDraftRevision,
      );
      this.latestDraftRevision = snapshot.draftRevision;
    }
    this.clearTimer();
    this.pending = this.persistSnapshot(state, snapshot).status === "persisted" ? null : snapshot;
  }

  persistChangedState() {
    this.persistNow();
    this.synchronizeDurablePersistence();
  }

  scopeForRouteSwitch(): StoredChatOutboxScope | null {
    const state = this.getState();
    if (!state) {
      return null;
    }
    const current = this.snapshot(state);
    const snapshot =
      this.pending ?? (this.isUnchanged(current) ? (this.lastPersisted ?? current) : current);
    return snapshot.scope;
  }

  persistForRouteSwitchResult(): ChatComposerPersistResult {
    const state = this.getState();
    if (!state) {
      return { status: "persisted" };
    }
    let snapshot = this.pending;
    let enforceExpectedRevision = false;
    const current = this.snapshot(state);
    if (!snapshot && this.ready && this.isUnchanged(current)) {
      const baseline = this.lastPersisted ?? current;
      if (!baseline.chatMessage && !baseline.goalMode && baseline.attachments.length === 0) {
        this.pending = null;
        this.clearTimer();
        return { status: "persisted" };
      }
      const revisions = this.readDraftRevisions(state, baseline.scope);
      const storedRevision = revisions.committed;
      const stored = loadCapturedComposer(state, baseline.scope);
      if (
        baseline.attachments.length === 0 &&
        storedRevision === baseline.draftRevision &&
        stored?.draft === baseline.chatMessage &&
        JSON.stringify(stored?.goalMode ?? null) === JSON.stringify(baseline.goalMode ?? null)
      ) {
        this.pending = null;
        this.clearTimer();
        return { status: "persisted" };
      }
      if (storedRevision !== baseline.draftRevision || Boolean(stored?.draft || stored?.goalMode)) {
        return { status: "conflict" };
      }
      // A newer failed attempt still represents newer pane input. An
      // untouched pane must not mint a later revision for its stale draft and
      // fence that edit out merely because retention evicted the stored row.
      if (revisions.latestAttempt > baseline.draftRevision) {
        return { status: "conflict" };
      }
      snapshot = {
        ...baseline,
        expectedDraftRevision: storedRevision,
        draftRevision: nextDraftRevision(
          Math.max(storedRevision, revisions.latestAttempt, this.latestDraftRevision),
        ),
      };
      this.latestDraftRevision = snapshot.draftRevision;
      enforceExpectedRevision = true;
    } else if (!snapshot && !this.ready && !current.chatMessage && !current.goalMode) {
      this.pending = null;
      this.clearTimer();
      return { status: "persisted" };
    }
    snapshot ??= this.snapshot(
      state,
      nextDraftRevision(this.latestDraftRevision),
      this.committedDraftRevision,
    );
    this.latestDraftRevision = Math.max(this.latestDraftRevision, snapshot.draftRevision);
    this.clearTimer();
    const result = this.persistSnapshot(state, snapshot, enforceExpectedRevision);
    this.pending = result.status === "persisted" ? null : snapshot;
    return result;
  }

  private persistSnapshot(
    state: DurableChatComposerPersistenceState,
    snapshot: ChatComposerDraftSnapshot,
    enforceExpectedRevision = false,
  ): ChatComposerPersistResult {
    const status = writeComposerSnapshot(state, snapshot, {
      draft: snapshot.chatMessage,
      goalMode: snapshot.goalMode ?? null,
      draftRevision: snapshot.draftRevision,
      ...(enforceExpectedRevision ? { expectedDraftRevision: snapshot.expectedDraftRevision } : {}),
    });
    if (snapshot.durable) {
      this.durablePersistence.persist(snapshot.durable);
    }
    if (status === "persisted") {
      this.committedDraftRevision = snapshot.draftRevision;
      this.latestDraftRevision = Math.max(this.latestDraftRevision, snapshot.draftRevision);
      this.lastPersisted = snapshot;
      return { status };
    }
    if (status === "storage-failed") {
      return {
        status,
        expectedDraftRevision: snapshot.expectedDraftRevision,
        draftRevision: snapshot.draftRevision,
      };
    }
    return { status };
  }

  private clearTimer() {
    if (this.timer === null) {
      return;
    }
    globalThis.clearTimeout(this.timer);
    this.timer = null;
  }

  private isUnchanged(snapshot: ChatComposerDraftSnapshot): boolean {
    const last = this.lastPersisted;
    return Boolean(
      last &&
      last.sessionKey === snapshot.sessionKey &&
      chatAttachmentDraftSignature(last.chatMessage, last.attachments, last.goalMode) ===
        chatAttachmentDraftSignature(snapshot.chatMessage, snapshot.attachments, snapshot.goalMode),
    );
  }

  private snapshot(
    state: DurableChatComposerPersistenceState,
    draftRevision: number = this.latestDraftRevision,
    expectedDraftRevision: number = this.committedDraftRevision,
  ): ChatComposerDraftSnapshot {
    const scope = resolveStoredChatOutboxScope(state, state.sessionKey);
    const durableScope = this.resolveDurableScope(state, scope);
    const goalMode = state.chatGoalDraftMode ? { ...state.chatGoalDraftMode } : undefined;
    const attachments = (state.chatAttachments ?? []).map((attachment) =>
      Object.assign(
        {},
        attachment,
        attachment.browserAnnotation
          ? { browserAnnotation: Object.assign({}, attachment.browserAnnotation) }
          : {},
      ),
    );
    const durable = durableScope
      ? {
          scope: durableScope,
          expectedRevision: expectedDraftRevision,
          revision: draftRevision,
          text: normalizeChatComposerDraft(state.chatMessage),
          ...(goalMode ? { goalMode } : {}),
          storedAttachments: captureDurableChatAttachments(attachments),
          writeId: `${draftRevision}:${Math.random().toString(36).slice(2)}`,
        }
      : undefined;
    return {
      scope,
      awaitingDefaults: !hasUiSessionDefaults(state),
      sessionKey: state.sessionKey,
      chatMessage: normalizeChatComposerDraft(state.chatMessage),
      ...(goalMode ? { goalMode } : {}),
      expectedDraftRevision,
      draftRevision,
      attachments,
      ...(durable ? { durable } : {}),
    };
  }

  private resolveDurableScope(
    state: DurableChatComposerPersistenceState,
    scope: StoredChatOutboxScope = resolveStoredChatOutboxScope(state, state.sessionKey),
  ) {
    if (state.selectedChatSessionIncognito) {
      return null;
    }
    return (
      this.resolveConnectedDurableScope(state, scope) ??
      (this.durableOwner &&
      !state.connected &&
      this.durableOwner.client === state.client &&
      this.durableOwner.gatewayOwner ===
        storageTargetForGateway(state.settings?.gatewayUrl).gatewayOwner
        ? { ...this.durableOwner, scopeKey: `chat:v3:${storedChatOutboxScopeKey(scope)}` }
        : null)
    );
  }

  private resolveConnectedDurableScope(
    state: DurableChatComposerPersistenceState,
    scope: StoredChatOutboxScope = resolveStoredChatOutboxScope(state, state.sessionKey),
  ) {
    const recoveryScope = state.client?.recoveryScope?.trim();
    if (!state.connected || !state.client?.recoveryScopeReady || !recoveryScope) {
      return null;
    }
    return {
      gatewayOwner: storageTargetForGateway(state.settings?.gatewayUrl).gatewayOwner,
      recoveryScope,
      scopeKey: `chat:v3:${storedChatOutboxScopeKey(scope)}`,
    };
  }

  private synchronizeDurablePersistence() {
    const state = this.getState();
    if (!this.ready || !state) {
      return;
    }
    const connectedScope = this.resolveConnectedDurableScope(state);
    if (state.selectedChatSessionIncognito) {
      if (connectedScope) {
        const scopeKey = durableComposerScopeIdentity(connectedScope);
        if (this.durableRetiredScopeKey !== scopeKey) {
          this.durableRetiredScopeKey = scopeKey;
          this.durableOwner = null;
          this.forceDurableOwnerRestore = false;
          this.durableRestoreProtected = false;
          this.durablePersistence.retire(connectedScope, this.latestDraftRevision);
        }
      }
      return;
    }
    this.durableRetiredScopeKey = "";
    const scope = connectedScope;
    if (!scope) {
      return;
    }
    const previousOwner = this.durableOwner;
    // Draft writes notify panes synchronously. Publish the new owner before
    // clearing the old draft so reentrant persistence cannot repeat this transition.
    this.durableOwner = {
      client: state.client,
      gatewayOwner: scope.gatewayOwner,
      recoveryScope: scope.recoveryScope,
    };
    if (
      previousOwner &&
      (previousOwner.gatewayOwner !== scope.gatewayOwner ||
        previousOwner.recoveryScope !== scope.recoveryScope)
    ) {
      releaseChatAttachmentPayloads(state.chatAttachments);
      state.chatMessage = "";
      state.chatGoalDraftMode = null;
      state.chatAttachments = [];
      this.pending = null;
      const revisions = this.readDraftRevisions(state);
      this.committedDraftRevision = revisions.committed;
      this.latestDraftRevision = nextDraftRevision(revisions.latestAttempt);
      writeComposerState(state, state.sessionKey, {
        draft: "",
        goalMode: null,
        draftRevision: this.latestDraftRevision,
      });
      this.committedDraftRevision = this.latestDraftRevision;
      this.lastPersisted = this.snapshot(state, this.latestDraftRevision, this.latestDraftRevision);
      this.durableRestoreProtected = false;
      this.forceDurableOwnerRestore = true;
      this.durablePersistence.resetRestoreScope();
    }
    if (this.durableRestoreProtected) {
      this.durableRestoreProtected = false;
      const snapshot = this.snapshot(
        state,
        nextDraftRevision(this.latestDraftRevision),
        this.committedDraftRevision,
      );
      this.latestDraftRevision = snapshot.draftRevision;
      this.persistSnapshot(state, snapshot);
      return;
    }
    const baseline = this.snapshot(state, this.latestDraftRevision, this.committedDraftRevision);
    const restoreRevision = this.forceDurableOwnerRestore ? 0 : this.latestDraftRevision;
    this.durablePersistence.restore(
      {
        scope,
        latestRevision: restoreRevision,
        signature: chatAttachmentDraftSignature(
          state.chatMessage,
          state.chatAttachments ?? [],
          state.chatGoalDraftMode,
        ),
      },
      () => ({
        scope: this.resolveDurableScope(state),
        signature: chatAttachmentDraftSignature(
          state.chatMessage,
          state.chatAttachments ?? [],
          state.chatGoalDraftMode,
        ),
        revision: this.forceDurableOwnerRestore ? 0 : this.latestDraftRevision,
      }),
      (draft) => {
        const forceOwnerRestore = this.forceDurableOwnerRestore;
        this.forceDurableOwnerRestore = false;
        const displaced = state.chatAttachments ?? [];
        state.chatMessage = normalizeChatComposerDraft(draft.text);
        state.chatGoalDraftMode = draft.goalMode ?? null;
        state.chatAttachments = draft.attachments;
        releaseChatAttachmentPayloads(displaced);
        const adoptedRevision = forceOwnerRestore
          ? nextDraftRevision(Math.max(this.latestDraftRevision, draft.revision))
          : draft.revision;
        // Storage presence notifications synchronously invalidate every pane. Adopt
        // the complete restored draft before they can schedule another write.
        this.committedDraftRevision = adoptedRevision;
        this.latestDraftRevision = adoptedRevision;
        this.lastPersisted = this.snapshot(state, adoptedRevision, adoptedRevision);
        writeComposerState(state, state.sessionKey, {
          agentId: resolveStoredChatOutboxScope(state, state.sessionKey).agentId,
          draft: state.chatMessage,
          goalMode: state.chatGoalDraftMode,
          draftRevision: adoptedRevision,
        });
        if (forceOwnerRestore && this.lastPersisted.durable) {
          this.durablePersistence.persist({
            ...this.lastPersisted.durable,
            expectedRevision: draft.revision,
          });
        }
        state.requestUpdate?.();
      },
      (storedRevision) => {
        this.forceDurableOwnerRestore = false;
        if (
          baseline.durable &&
          (state.chatMessage || state.chatGoalDraftMode || (state.chatAttachments?.length ?? 0) > 0)
        ) {
          this.durablePersistence.persist({
            ...baseline.durable,
            expectedRevision: storedRevision,
          });
        }
      },
    );
  }

  private readDraftRevisions(
    state: DurableChatComposerPersistenceState,
    scope = resolveStoredChatOutboxScope(state, state.sessionKey),
  ): ReturnType<typeof loadComposerRevisions> {
    return loadComposerRevisions(state, scope);
  }
}
