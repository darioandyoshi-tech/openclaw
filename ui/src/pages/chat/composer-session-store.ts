import type {
  ChatAttachment,
  ChatGoalDraftMode,
  ChatQueueItem,
} from "../../lib/chat/chat-types.ts";
import { outboxPayloadMatchesOwner } from "../../lib/chat/outbox-payload-store.runtime.ts";
import {
  nextDraftRevision,
  rememberDraftAttempt,
  rememberDraftRevision,
  readDraftRevisionState,
} from "../../lib/chat/outbox-store-draft-state.ts";
import {
  captureChatOutboxAdmission,
  notifyStoredChatOutboxChanges,
  readStoredOutboxStore as readStore,
  resolvePendingComposerSessions,
  resolveStoredChatOutboxScope,
  storedChatOutboxScopeKey,
  storageTargetForGateway,
  writeStoredOutboxStore as writeStore,
  type ChatComposerScope,
  type StoredChatOutboxScope,
} from "../../lib/chat/outbox-store.ts";
import { getSafeSessionStorage } from "../../local-storage.ts";
import { normalizeChatComposerDraft } from "./composer-draft.ts";
import { serializeQueueEntry } from "./composer-queue-store.ts";

export type ComposerPersistenceState = {
  settings?: { gatewayUrl?: string | null };
  assistantAgentId?: string | null;
  agentsList?: { defaultId?: string | null; mainKey?: string | null; scope?: string | null } | null;
  hello?: {
    snapshot?: unknown;
  } | null;
  sessionKey: string;
  chatMessage: string;
  chatGoalDraftMode?: ChatGoalDraftMode | null;
  chatAttachments?: ChatAttachment[];
  chatQueue: ChatQueueItem[];
  client?: { recoveryScope?: string; recoveryScopeReady?: boolean } | null;
  connected?: boolean;
  lastError?: string | null;
  chatError?: string | null;
  requestUpdate?: () => void;
};

export type ComposerRestoreOptions = {
  preserveCurrent?: boolean;
  sessionKey?: string;
};

type ChatComposerPersistStatus = "persisted" | "conflict" | "storage-failed";

type ChatComposerPersistOptions = {
  agentId?: string;
  draft?: string;
  goalMode?: ChatGoalDraftMode | null;
  draftRevision?: number;
  expectedDraftRevision?: number;
};

type ChatComposerDraftRevisionState = ReturnType<typeof readDraftRevisionState>;

export function loadComposerRevisions(
  state: ChatComposerScope,
  scope: StoredChatOutboxScope,
): ChatComposerDraftRevisionState {
  const storage = getSafeSessionStorage();
  if (!storage) {
    return { committed: 0, latestAttempt: 0 };
  }
  try {
    const target = storageTargetForGateway(state.settings?.gatewayUrl);
    const store = readStore(storage, target);
    const migrated = resolvePendingComposerSessions(store, state);
    const storeSessionKey = storedChatOutboxScopeKey(scope);
    const session = store.sessions[storeSessionKey] ?? null;
    if (migrated) {
      try {
        writeStore(storage, target, store);
      } catch {
        // The readable draft is still the concurrency baseline for this pane.
      }
    }
    const storedDraftRevision = session?.draftRevision;
    rememberDraftRevision(storage, target.key, storeSessionKey, storedDraftRevision);
    return readDraftRevisionState(storage, target.key, storeSessionKey, storedDraftRevision);
  } catch {
    return { committed: 0, latestAttempt: 0 };
  }
}

export function loadChatComposerDraftRevision(
  state: ChatComposerScope,
  sessionKey: string,
  agentIdOverride?: string,
): number {
  return loadComposerRevisions(
    state,
    resolveStoredChatOutboxScope(state, sessionKey, agentIdOverride),
  ).latestAttempt;
}

export function loadChatComposerCommittedDraftRevision(
  state: ChatComposerScope,
  sessionKey: string,
  agentIdOverride?: string,
): number {
  return loadComposerRevisions(
    state,
    resolveStoredChatOutboxScope(state, sessionKey, agentIdOverride),
  ).committed;
}

export function loadChatComposerSnapshot(
  state: Pick<
    ComposerPersistenceState,
    "settings" | "assistantAgentId" | "agentsList" | "hello" | "client" | "connected"
  >,
  sessionKey: string,
  agentIdOverride?: string,
): { draft: string; goalMode?: ChatGoalDraftMode; queue: ChatQueueItem[] } | null {
  return loadCapturedComposer(
    state,
    resolveStoredChatOutboxScope(state, sessionKey, agentIdOverride),
  );
}

export function loadCapturedComposer(
  state: Pick<
    ComposerPersistenceState,
    "settings" | "assistantAgentId" | "agentsList" | "hello" | "client" | "connected"
  >,
  captured: StoredChatOutboxScope,
): { draft: string; goalMode?: ChatGoalDraftMode; queue: ChatQueueItem[] } | null {
  const storage = getSafeSessionStorage();
  if (!storage) {
    return null;
  }
  try {
    const target = storageTargetForGateway(state.settings?.gatewayUrl);
    const store = readStore(storage, target);
    const migrated = resolvePendingComposerSessions(store, state);
    if (migrated) {
      try {
        writeStore(storage, target, store);
      } catch {
        // Migration persistence is best-effort; readable drafts and outboxes remain usable.
      }
    }
    const session = store.sessions[storedChatOutboxScopeKey(captured)];
    const draft = normalizeChatComposerDraft(session?.draft ?? "");
    if (!session || (!draft && !session.goalMode && !session.queue?.length)) {
      return null;
    }
    return {
      draft,
      ...(session.goalMode ? { goalMode: session.goalMode } : {}),
      queue: (session.queue ?? [])
        .filter((item) => outboxPayloadMatchesOwner(state, item))
        .map((item) => serializeQueueEntry(item, captured))
        .filter((item): item is ChatQueueItem => item !== null),
    };
  } catch {
    return null;
  }
}

export function writeComposerState(
  state: ComposerPersistenceState,
  sessionKey: string = state.sessionKey,
  options: ChatComposerPersistOptions = {},
): ChatComposerPersistStatus {
  return writeComposerSnapshot(
    state,
    captureChatOutboxAdmission(state, sessionKey, options.agentId),
    options,
  );
}

export function writeComposerSnapshot(
  state: ComposerPersistenceState,
  captured: { scope: StoredChatOutboxScope; awaitingDefaults: boolean },
  options: ChatComposerPersistOptions = {},
): ChatComposerPersistStatus {
  const storage = getSafeSessionStorage();
  if (!storage || !captured.scope.sessionKey.trim()) {
    return "storage-failed";
  }
  try {
    const target = storageTargetForGateway(state.settings?.gatewayUrl);
    const store = readStore(storage, target);
    const storeSessionKey = storedChatOutboxScopeKey(captured.scope);
    const session = store.sessions[storeSessionKey] ?? null;
    const draft = normalizeChatComposerDraft(
      Object.hasOwn(options, "draft") ? (options.draft ?? "") : state.chatMessage,
    );
    const goalMode = Object.hasOwn(options, "goalMode")
      ? options.goalMode
      : state.chatGoalDraftMode;
    const storedDraftRevision = session?.draftRevision;
    rememberDraftRevision(storage, target.key, storeSessionKey, storedDraftRevision);
    // Draft-only rows are bounded and may evict a clear tombstone. Retain the
    // seen revision while this tab is alive so an older failed write cannot
    // treat an evicted scope as revision zero and resurrect stale input.
    const { committed: committedDraftRevision, latestAttempt: newestDraftAttempt } =
      readDraftRevisionState(storage, target.key, storeSessionKey, storedDraftRevision);
    const draftRevision = options.draftRevision ?? nextDraftRevision(newestDraftAttempt);
    if (!Number.isSafeInteger(draftRevision) || draftRevision <= 0) {
      return "conflict";
    }
    const storedDraft = normalizeChatComposerDraft(session?.draft ?? "");
    // Draft interpretation shares the text revision; a retry cannot turn an objective into a command.
    const sameDraft =
      storedDraft === draft &&
      JSON.stringify(session?.goalMode ?? null) === JSON.stringify(goalMode ?? null);
    const expectedDraftRevision = options.expectedDraftRevision;
    const committedMatchesExpected =
      expectedDraftRevision === undefined ||
      committedDraftRevision === expectedDraftRevision ||
      (storedDraftRevision === draftRevision && sameDraft);
    // Reserve every accepted attempt before touching storage. A newer failed
    // edit or clear must fence out older pane fallbacks when capacity recovers.
    if (
      !committedMatchesExpected ||
      draftRevision < newestDraftAttempt ||
      (storedDraftRevision === draftRevision && !sameDraft)
    ) {
      return "conflict";
    }
    rememberDraftAttempt(storage, target.key, storeSessionKey, draftRevision);
    store.sessions[storeSessionKey] = {
      ...(captured.awaitingDefaults ? { awaitingDefaults: true as const } : {}),
      ...(draft ? { draft } : {}),
      ...(goalMode ? { goalMode } : {}),
      draftRevision,
      ...(session?.queue?.length ? { queue: session.queue } : {}),
      updatedAt: Date.now(),
    };
    writeStore(storage, target, store);
    const persisted = readStore(storage, target).sessions[storeSessionKey];
    if (
      persisted?.draftRevision === draftRevision &&
      (persisted.draft ?? "") === draft &&
      JSON.stringify(persisted.goalMode ?? null) === JSON.stringify(goalMode ?? null)
    ) {
      // Notify only on presence transitions: sidebar draft indicators consume
      // presence, and content-only notifies would let projection subscribers
      // re-persist a stale pane over a newer draft (route-fallback invariant).
      if (Boolean(storedDraft) !== Boolean(draft)) {
        notifyStoredChatOutboxChanges();
      }
      return "persisted";
    }
    // Retention limits can make a successful storage write omit this draft.
    // Only a same/newer revision is a concurrency conflict; a missing or older
    // row remains retryable as a storage-capacity failure.
    return (persisted?.draftRevision ?? 0) >= draftRevision ? "conflict" : "storage-failed";
  } catch {
    // Best-effort only: quota and privacy-mode storage errors should not break chat.
    return "storage-failed";
  }
}

export function persistChatComposerState(
  state: ComposerPersistenceState,
  sessionKey: string = state.sessionKey,
  options: ChatComposerPersistOptions = {},
): boolean {
  return writeComposerState(state, sessionKey, options) === "persisted";
}

export function restoreChatComposerState(
  state: ComposerPersistenceState,
  options: ComposerRestoreOptions = {},
): boolean {
  state.chatMessage = normalizeChatComposerDraft(state.chatMessage);
  const sessionKey = options.sessionKey ?? state.sessionKey;
  const snapshot = loadChatComposerSnapshot(state, sessionKey);
  if (!snapshot) {
    return false;
  }
  if (!options.preserveCurrent || (!state.chatMessage && !state.chatGoalDraftMode)) {
    state.chatMessage = normalizeChatComposerDraft(snapshot.draft);
    state.chatGoalDraftMode = snapshot.goalMode ?? null;
  }
  if ((!options.preserveCurrent && snapshot.queue.length > 0) || state.chatQueue.length === 0) {
    state.chatQueue = snapshot.queue;
  }
  return true;
}
