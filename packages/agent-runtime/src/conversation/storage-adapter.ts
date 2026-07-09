import type {
  ConversationStorage,
  ConversationStorageListOptions,
  ConversationStorageTransaction,
} from "./types";

function transactionAdapter(
  transaction: DurableObjectTransaction,
): ConversationStorageTransaction {
  return {
    get: <T>(key: string) => transaction.get<T>(key),
    list: <T>(options?: ConversationStorageListOptions) =>
      transaction.list<T>(options),
    put: <T>(key: string, value: T) => transaction.put(key, value),
    delete: (key: string | string[]) =>
      Array.isArray(key) ? transaction.delete(key) : transaction.delete(key),
    setAlarm: (scheduledTime: number | Date) =>
      transaction.setAlarm(scheduledTime),
    deleteAlarm: () => transaction.deleteAlarm(),
  };
}

export function durableObjectStorageAdapter(
  storage: DurableObjectStorage,
): ConversationStorage {
  return {
    get: <T>(key: string) => storage.get<T>(key),
    list: <T>(options?: ConversationStorageListOptions) =>
      storage.list<T>(options),
    transaction: <T>(
      closure: (transaction: ConversationStorageTransaction) => Promise<T>,
    ) => storage.transaction((transaction) =>
      closure(transactionAdapter(transaction))
    ),
  };
}
