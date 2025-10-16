import { co, z, Account, Group } from "jazz-tools";
import {
  CojsonInternalTypes,
  emptyKnownState,
  SessionID,
  CoID,
  RawCoValue,
} from "cojson";

export const SuccessMap = co.record(
  z.string(), // sessionID
  z.object({
    continouslySuccessfulUpTo: z.number(),
    laterSuccessfulTransactions: z.array(z.number()),
  }),
);

export const WebhookRegistration = co.map({
  webhookUrl: z.string(),
  coValueId: z.string(),
  active: z.boolean(),
  successMap: SuccessMap,
});
export type WebhookRegistration = co.loaded<typeof WebhookRegistration>;

export const RegistryState = co.record(z.string(), WebhookRegistration);
export type RegistryState = co.loaded<typeof RegistryState>;

export interface JazzWebhookOptions {
  /** Maximum number of retry attempts for failed webhooks (default: 5) */
  maxRetries?: number;
  /** Base delay in milliseconds for exponential backoff (default: 1000ms) */
  baseDelayMs?: number;
}

export const DEFAULT_JazzWebhookOptions: Required<JazzWebhookOptions> = {
  maxRetries: 3,
  baseDelayMs: 1000,
};

export class WebhookRegistry {
  public state: RegistryState;
  private activeSubscriptions = new Map<string, () => void>();
  private rootUnsubscribe: (() => void) | null = null;

  constructor(
    registry: RegistryState,
    private options: JazzWebhookOptions = {},
  ) {
    this.state = registry;
  }

  static createRegistry(owner: Group | Account): RegistryState {
    return RegistryState.create({}, owner);
  }

  static async loadAndStart(
    registryId: string,
    options: JazzWebhookOptions = {},
  ) {
    const registry = await RegistryState.load(registryId);

    if (!registry) {
      throw new Error(`Webhook registry with ID ${registryId} not found`);
    }

    const webhook = new WebhookRegistry(registry, options);
    webhook.start();
    return webhook;
  }

  /**
   * Registers a new webhook for a CoValue.
   *
   * @param webhookUrl - The HTTP URL to call when the CoValue changes
   * @param coValueId - The ID of the CoValue to monitor (must start with "co_z")
   * @returns The ID of the registered webhook
   */
  register(webhookUrl: string, coValueId: string): Promise<string> {
    return registerWebhook(this.state.$jazz.id, webhookUrl, coValueId);
  }

  /**
   * Unregisters a webhook and stops monitoring the CoValue.
   *
   * @param webhookId - The ID of the webhook to unregister
   */
  unregister(webhookId: string): void {
    const webhook = this.state[webhookId];
    if (!webhook) {
      throw new Error(`Webhook with ID ${webhookId} not found`);
    }

    this.state.$jazz.delete(webhookId);
    webhook.$jazz.set("active", false);
  }

  /**
   * Starts monitoring a CoValue and emitting webhooks when it changes.
   *
   * @param webhookId - The ID of the webhook to start monitoring
   */
  private subscribe(webhook: WebhookRegistration) {
    const emitter = new WebhookEmitter(webhook, this.options);

    this.activeSubscriptions.set(webhook.$jazz.id, () => {
      emitter.stop();
      this.activeSubscriptions.delete(webhook.$jazz.id);
    });
  }

  /**
   * Starts monitoring all active webhooks in the registry.
   *
   * This method iterates through all webhooks in the registry and starts
   * subscriptions for any active webhooks that don't already have active
   * subscriptions. This is useful for resuming webhook monitoring after
   * a shutdown or when loading an existing registry.
   */
  async start(): Promise<void> {
    if (this.rootUnsubscribe) {
      return;
    }

    // TODO: this would be much more efficient with subscription diffs
    const createAndDeleteSubscriptions = (
      registry: co.loaded<typeof RegistryState, { $each: true }>,
    ) => {
      for (const webhook of Object.values(registry)) {
        const exists = this.activeSubscriptions.has(webhook.$jazz.id);
        if (webhook.active && !exists) {
          this.subscribe(webhook);
        }
      }
      for (const [id, unsubscribe] of this.activeSubscriptions.entries()) {
        if (!registry[id]) {
          unsubscribe();
          this.activeSubscriptions.delete(id);
        }
      }
    };

    this.rootUnsubscribe = this.state.$jazz.subscribe(
      {
        resolve: {
          $each: true,
        },
      },
      createAndDeleteSubscriptions,
    );
  }

  shutdown(): void {
    for (const unsubscribe of this.activeSubscriptions.values()) {
      unsubscribe();
    }
    this.rootUnsubscribe?.();
    this.rootUnsubscribe = null;
  }
}

/**
 * Manages webhook emission with queuing, retry logic, and exponential backoff.
 *
 * The WebhookEmitter handles sending HTTP POST requests to webhook callbacks when
 * a CoValue changes. It implements several key behaviors:
 *
 */
class WebhookEmitter {
  successMap: Promise<co.loaded<typeof SuccessMap, { $each: true }>>;
  loadedSuccessMap: co.loaded<typeof SuccessMap, { $each: true }> | undefined;
  pending = new Map<
    string, // stringified TransactionID
    { nRetries: number; timeout: NodeJS.Timeout }
  >();
  unsubscribe: () => void;

  constructor(
    private webhook: WebhookRegistration,
    private options: JazzWebhookOptions = {},
  ) {
    this.successMap = webhook.$jazz
      .ensureLoaded({ resolve: { successMap: { $each: true } } })
      .then((loaded) => {
        this.loadedSuccessMap = loaded.successMap;
        return loaded.successMap;
      });
    this.unsubscribe = this.webhook.$jazz.localNode.subscribe(
      this.webhook.coValueId as CoID<RawCoValue>,
      async (value) => {
        if (value === "unavailable") {
          return;
        }
        const todo = Array.from(
          getTransactionsToRetry(
            await this.successMap,
            value.core.knownState(),
          ),
        );
        console.log("todo", todo);
        for (const txID of todo) {
          if (!this.pending.has(`${txID.sessionID}:${txID.txIndex}`)) {
            this.makeAttempt(txID);
          }
        }
      },
    );
  }

  stop() {
    this.pending.forEach((entry) => {
      clearTimeout(entry.timeout);
    });
    this.pending.clear();
    this.unsubscribe();
  }

  makeAttempt(txID: CojsonInternalTypes.TransactionID) {
    const entry = this.pending.get(`${txID.sessionID}:${txID.txIndex}`);

    console.log("makeAttempt", this.webhook.coValueId, txID, {
      nRetries: entry?.nRetries,
      successful:
        this.loadedSuccessMap && isTxSuccessful(this.loadedSuccessMap, txID),
    });

    if (
      entry &&
      entry.nRetries >=
        (this.options.maxRetries || DEFAULT_JazzWebhookOptions.maxRetries)
    ) {
      this.pending.delete(`${txID.sessionID}:${txID.txIndex}`);
      clearTimeout(entry.timeout);
      return;
    }

    const timeout = setTimeout(
      () => {
        this.makeAttempt(txID);
      },
      (this.options.baseDelayMs || DEFAULT_JazzWebhookOptions.baseDelayMs) *
        2 ** (entry?.nRetries || 0),
    );

    if (entry) {
      entry.nRetries++;
      clearTimeout(entry.timeout);
      entry.timeout = timeout;
    } else {
      this.pending.set(`${txID.sessionID}:${txID.txIndex}`, {
        nRetries: 0,
        timeout,
      });
    }

    fetch(this.webhook.webhookUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        coValueId: this.webhook.coValueId,
        txID: txID,
      }),
    })
      .then(async (response) => {
        if (response.ok) {
          markSuccessful(await this.successMap, txID);
          this.pending.delete(`${txID.sessionID}:${txID.txIndex}`);
          clearTimeout(timeout);
          return;
        } else {
          throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }
      })
      .catch((error) => {
        console.error(
          `Webhook request failed (attempt ${entry?.nRetries || 0}):`,
          error,
        );
      });
  }
}

export const registerWebhook = async (
  registryId: string,
  webhookUrl: string,
  coValueId: string,
): Promise<string> => {
  try {
    new URL(webhookUrl);
  } catch {
    throw new Error(`Invalid webhook URL: ${webhookUrl}`);
  }

  if (!registryId.startsWith("co_z")) {
    throw new Error(
      `Invalid Registry ID format: ${coValueId}. Expected format: co_z...`,
    );
  }

  if (!coValueId.startsWith("co_z")) {
    throw new Error(
      `Invalid CoValue ID format: ${coValueId}. Expected format: co_z...`,
    );
  }

  const registry = await RegistryState.load(registryId);

  if (!registry) {
    throw new Error(`Couldn't load registry with ID ${registryId}`);
  }

  const registration = WebhookRegistration.create(
    {
      webhookUrl,
      coValueId,
      active: true,
      successMap: SuccessMap.create({}, registry.$jazz.owner),
    },
    registry.$jazz.owner,
  );

  registry.$jazz.set(registration.$jazz.id, registration);

  return registration.$jazz.id;
};

function markSuccessful(
  successMap: co.loaded<typeof SuccessMap, { $each: true }>,
  txID: CojsonInternalTypes.TransactionID,
) {
  let entry = successMap[txID.sessionID];
  if (!entry) {
    entry = {
      continouslySuccessfulUpTo: 0,
      laterSuccessfulTransactions: [],
    };
    successMap.$jazz.set(txID.sessionID, entry);
  }

  let newContinouslySuccessfulUpTo = entry.continouslySuccessfulUpTo;
  let newLaterSuccessfulTransactions = [
    ...entry.laterSuccessfulTransactions,
    txID.txIndex,
  ];

  while (
    newLaterSuccessfulTransactions.length > 0 &&
    newLaterSuccessfulTransactions[0] === newContinouslySuccessfulUpTo + 1
  ) {
    newContinouslySuccessfulUpTo++;
    newLaterSuccessfulTransactions.shift();
  }

  successMap.$jazz.set(txID.sessionID, {
    continouslySuccessfulUpTo: newContinouslySuccessfulUpTo,
    laterSuccessfulTransactions: newLaterSuccessfulTransactions,
  });
}

function* getTransactionsToRetry(
  successMap: co.loaded<typeof SuccessMap, { $each: true }>,
  knownState: CojsonInternalTypes.CoValueKnownState,
) {
  for (const [sessionID, knownTxCount] of Object.entries(knownState.sessions)) {
    const entry = successMap[sessionID];

    console.log("entry", sessionID, entry);

    const start = entry ? entry.continouslySuccessfulUpTo + 1 : 0;
    const end = knownTxCount;

    for (let txIndex = start; txIndex < end; txIndex++) {
      if (!entry?.laterSuccessfulTransactions.includes(txIndex)) {
        yield {
          sessionID: sessionID as SessionID,
          txIndex: txIndex,
        } satisfies CojsonInternalTypes.TransactionID;
      }
    }
  }
}

export function isTxSuccessful(
  successMap: co.loaded<typeof SuccessMap, { $each: true }>,
  txID: CojsonInternalTypes.TransactionID,
) {
  const entry = successMap[txID.sessionID];
  if (!entry) {
    return false;
  }
  return (
    entry.continouslySuccessfulUpTo >= txID.txIndex ||
    entry.laterSuccessfulTransactions.includes(txID.txIndex)
  );
}
