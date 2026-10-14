// Service bypass audit identities belong to individual HTTP requests. Reusing
// one SDK instance's requestId across checkpoint writes collides with its audit
// record once the audit timestamp changes.
export function freshDocuments(createClient, collection) {
  return {
    get: id => createClient().documents(collection).get(id),
    query: query => createClient().documents(collection).query(query),
    mutate: (id, mutation) => createClient().documents(collection).mutate(id, mutation),
  };
}
