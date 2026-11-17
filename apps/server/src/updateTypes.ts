/** Minimal shape of the update service that buildApp needs; Task 2 provides the implementation. */
export interface UpdateServiceLike {
  state(): Promise<unknown>;
  skip(version: string): Promise<void>;
}
