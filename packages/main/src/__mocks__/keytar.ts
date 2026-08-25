/**
 * Mock for keytar native module (not available in test environment)
 */
const store = new Map<string, string>();

export async function getPassword(_service: string, account: string): Promise<string | null> {
  return store.get(account) ?? null;
}

export async function setPassword(
  _service: string,
  account: string,
  password: string
): Promise<void> {
  store.set(account, password);
}

export async function deletePassword(_service: string, account: string): Promise<boolean> {
  return store.delete(account);
}

export async function findCredentials(
  _service: string
): Promise<Array<{ account: string; password: string }>> {
  return Array.from(store.entries()).map(([account, password]) => ({ account, password }));
}
