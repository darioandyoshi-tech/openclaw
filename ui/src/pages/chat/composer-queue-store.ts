import type { ChatQueueItem } from "../../lib/chat/chat-types.ts";
import {
  INTERRUPTED_SETTINGS_WAIT_ERROR,
  MAX_STORED_QUEUE_ITEMS,
  normalizeStoredQueueItem,
  sameQueuedDeliveryVersion,
  type StoredComposerSession,
} from "../../lib/chat/outbox-store-codec.ts";
import {
  applyStoredChatOutboxScope,
  captureChatOutboxAdmission,
  notifyStoredChatOutboxChanges,
  readStoredOutboxStore as readStore,
  resolvePendingComposerSessions,
  storedChatOutboxScopeKey,
  storageTargetForGateway,
  writeStoredOutboxStore as writeStore,
  type ChatComposerScope,
  type StoredChatOutboxScope,
  type StoredComposerState,
} from "../../lib/chat/outbox-store.ts";
import { getSafeSessionStorage } from "../../local-storage.ts";
import { getChatAttachmentDataUrl } from "./attachment-payload-store.ts";

export type StoredChatQueueReplacement = {
  id: string;
  expected: ChatQueueItem;
};

function serializeQueueItem(item: ChatQueueItem): ChatQueueItem | null {
  if (
    !item.id?.trim() ||
    (!item.text?.trim() &&
      !item.attachments?.length &&
      !item.attachmentPayload &&
      !item.attachmentStorageError) ||
    item.pendingRunId ||
    (item.sendState === "sending" && !item.sendRunId)
  ) {
    return null;
  }
  const attachments = (item.attachments ?? []).map((attachment) => {
    const { dataUrl: _dataUrl, previewUrl: _previewUrl, ...metadata } = attachment;
    // A failed migration owns no Blob yet: retain its inline bytes across reload.
    // Only a payload reference permits removing bytes from the stored queue row.
    if (item.attachmentPayload) {
      return metadata;
    }
    const dataUrl = getChatAttachmentDataUrl(attachment);
    if (dataUrl) {
      return Object.assign(metadata, { dataUrl });
    }
    return item.attachmentStorageError ? metadata : null;
  });
  if (item.attachments?.length && attachments.some((attachment) => attachment === null)) {
    return null;
  }
  return normalizeStoredQueueItem({
    ...item,
    attachments: attachments.length ? attachments : undefined,
    ...(item.sendState === "waiting-model" ? { sendError: INTERRUPTED_SETTINGS_WAIT_ERROR } : {}),
  });
}

export function serializeQueueEntry(
  item: ChatQueueItem,
  scope: StoredChatOutboxScope,
): ChatQueueItem | null {
  const serialized = serializeQueueItem(item);
  if (!serialized) {
    return null;
  }
  return applyStoredChatOutboxScope(serialized, scope);
}

function queueItemVersionMatches(
  stored: ChatQueueItem,
  expected: ChatQueueItem,
  scope: StoredChatOutboxScope,
): boolean {
  const canonicalExpected = serializeQueueEntry(expected, scope);
  return Boolean(canonicalExpected && sameQueuedDeliveryVersion(stored, canonicalExpected));
}

function queueItemsEqual(
  stored: ChatQueueItem,
  canonicalExpected: ChatQueueItem,
  scope: StoredChatOutboxScope,
): boolean {
  const canonicalStored = serializeQueueEntry(stored, scope);
  return Boolean(
    canonicalStored && JSON.stringify(canonicalStored) === JSON.stringify(canonicalExpected),
  );
}

function writeStoredComposerSession(
  store: StoredComposerState,
  storeSessionKey: string,
  session: StoredComposerSession | null,
  queue: ChatQueueItem[],
): void {
  if (
    !session?.draft &&
    !session?.goalMode &&
    session?.draftRevision === undefined &&
    queue.length === 0
  ) {
    delete store.sessions[storeSessionKey];
    return;
  }
  store.sessions[storeSessionKey] = {
    ...(session?.awaitingDefaults ? { awaitingDefaults: true } : {}),
    ...(session?.draft ? { draft: session.draft } : {}),
    ...(session?.goalMode ? { goalMode: session.goalMode } : {}),
    ...(session?.draftRevision !== undefined ? { draftRevision: session.draftRevision } : {}),
    ...(queue.length ? { queue } : {}),
    updatedAt: Date.now(),
  };
}

export function admitStoredChatComposerQueueItem(
  state: ChatComposerScope,
  sessionKey: string,
  item: ChatQueueItem,
  agentId?: string,
  replaces?: StoredChatQueueReplacement,
  captured = captureChatOutboxAdmission(state, sessionKey, agentId ?? item.agentId),
): boolean {
  const storage = getSafeSessionStorage();
  if (!storage || !sessionKey.trim()) {
    return false;
  }
  try {
    const target = storageTargetForGateway(state.settings?.gatewayUrl);
    const store = readStore(storage, target);
    const scope = captured.scope;
    const serialized = serializeQueueEntry(item, scope);
    if (!serialized) {
      return false;
    }
    const migrated = resolvePendingComposerSessions(store, state);
    const storeSessionKey = storedChatOutboxScopeKey(scope);
    const session = store.sessions[storeSessionKey] ?? null;
    // An edited row and its replacement are one write: the source is retired only
    // by the write that stores the replacement, so a rejected write leaves the
    // original queued instead of losing both copies. Filtering before the cap
    // check also keeps a replacement admissible on a full queue.
    const storedQueue = session?.queue ?? [];
    if (
      replaces &&
      !storedQueue.some(
        (entry) =>
          entry.id === replaces.id && queueItemVersionMatches(entry, replaces.expected, scope),
      )
    ) {
      return false;
    }
    const queue = storedQueue.filter((entry) => entry.id !== replaces?.id);
    const existing = queue.find((entry) => entry.id === serialized.id);
    if (existing) {
      if (!queueItemsEqual(existing, serialized, scope)) {
        return false;
      }
      if (migrated) {
        writeStore(storage, target, store);
        notifyStoredChatOutboxChanges();
      }
      return true;
    }
    if (queue.length >= MAX_STORED_QUEUE_ITEMS) {
      return false;
    }
    writeStoredComposerSession(store, storeSessionKey, session, [...queue, serialized]);
    if (captured.awaitingDefaults) {
      // SAFETY: writeStoredComposerSession retained the session with the admitted queue row.
      store.sessions[storeSessionKey]!.awaitingDefaults = true;
    }
    writeStore(storage, target, store);
    const persisted = readStore(storage, target).sessions[storeSessionKey]?.queue?.find(
      (entry) => entry.id === serialized.id,
    );
    // Verify the captured write before subscribers can change defaults or drain it.
    const admitted = Boolean(persisted && queueItemsEqual(persisted, serialized, scope));
    notifyStoredChatOutboxChanges();
    return admitted;
  } catch {
    return false;
  }
}

/**
 * Batch compare-and-set for durable queue rows. A caller passing several rows
 * (a reorder permutation) gets one fresh read, one validation pass over every
 * expected row, one full-document write, and one read-back verification — so
 * the whole set commits or none of it does. A mid-batch storage failure can
 * never leave a permutation half-applied the way a per-row write loop would.
 */
export function updateStoredChatComposerQueueItems(
  state: ChatComposerScope,
  sessionKey: string,
  updates: readonly { expected: ChatQueueItem; next: ChatQueueItem }[],
  agentId?: string,
): boolean {
  if (updates.length === 0) {
    return true;
  }
  const storage = getSafeSessionStorage();
  if (
    !storage ||
    !sessionKey.trim() ||
    updates.some(({ expected, next }) => expected.id !== next.id)
  ) {
    return false;
  }
  try {
    const target = storageTargetForGateway(state.settings?.gatewayUrl);
    const store = readStore(storage, target);
    const scope = {
      sessionKey,
      // SAFETY: the empty updates batch returned before reading its first row.
      agentId: agentId ?? updates[0]!.expected.agentId ?? updates[0]!.next.agentId,
    };
    const storeSessionKey = storedChatOutboxScopeKey(scope);
    const session = store.sessions[storeSessionKey] ?? null;
    const nextQueue = (session?.queue ?? []).slice();
    for (const { expected, next } of updates) {
      const index = nextQueue.findIndex((entry) => entry.id === expected.id);
      const stored = index >= 0 ? nextQueue[index] : undefined;
      const serializedNext =
        stored && queueItemVersionMatches(stored, expected, scope)
          ? serializeQueueEntry(next, scope)
          : null;
      if (!serializedNext) {
        // A missing or stale row rejects the whole batch before anything is written.
        return false;
      }
      nextQueue[index] = serializedNext;
    }
    writeStoredComposerSession(store, storeSessionKey, session, nextQueue);
    writeStore(storage, target, store);
    notifyStoredChatOutboxChanges();
    const persistedQueue = readStore(storage, target).sessions[storeSessionKey]?.queue ?? [];
    return updates.every(({ next }) => {
      const serializedNext = serializeQueueEntry(next, scope);
      const persisted = persistedQueue.find((entry) => entry.id === next.id);
      return Boolean(
        persisted && serializedNext && queueItemsEqual(persisted, serializedNext, scope),
      );
    });
  } catch {
    return false;
  }
}

export function updateStoredChatComposerQueueItem(
  state: ChatComposerScope,
  sessionKey: string,
  expected: ChatQueueItem,
  next: ChatQueueItem,
  agentId?: string,
): boolean {
  return updateStoredChatComposerQueueItems(state, sessionKey, [{ expected, next }], agentId);
}

export function removeStoredChatComposerQueueItem(
  state: ChatComposerScope,
  sessionKey: string,
  id: string,
  expected?: ChatQueueItem,
  agentId?: string,
): boolean {
  const storage = getSafeSessionStorage();
  if (!storage || !sessionKey.trim() || !id.trim()) {
    return false;
  }
  try {
    const target = storageTargetForGateway(state.settings?.gatewayUrl);
    const store = readStore(storage, target);
    const scope = { sessionKey, agentId: agentId ?? expected?.agentId };
    const storeSessionKey = storedChatOutboxScopeKey(scope);
    const session = store.sessions[storeSessionKey] ?? null;
    const queue = session?.queue ?? [];
    const index = queue.findIndex((item) => item.id === id);
    if (index < 0) {
      return true;
    }
    const stored = queue[index];
    if (!stored || (expected && !queueItemVersionMatches(stored, expected, scope))) {
      return false;
    }
    writeStoredComposerSession(
      store,
      storeSessionKey,
      session,
      queue.filter((_, queueIndex) => queueIndex !== index),
    );
    writeStore(storage, target, store);
    notifyStoredChatOutboxChanges();
    const persisted = readStore(storage, target).sessions[storeSessionKey]?.queue?.some(
      (item) => item.id === id,
    );
    return !persisted;
  } catch {
    return false;
  }
}
