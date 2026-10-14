// Read-only full-scale qualification; service key permits no mutations.
export async function qualifyPortfolio(documents, invoke, stage, offset = 0, count = 32) {
  let requests = 0;
  let payloadBytes = 0;
  const get = async (collection, id) => {
    requests += 1;
    const row = await documents(collection).get(id);
    if (!row || row._deleted || row.schemaVersion !== 1) throw new Error('missing_content');
    return row;
  };
  const started = performance.now();
  const head = await get('portfolio_heads', 'portfolio');
  const branches = {};
  for (const visibility of ['public','private']) {
    const root = head.body[`${visibility}_root`];
    const queue = [root];
    const found = [];
    const seen = new Set();
    while (queue.length) {
      const batch = queue.splice(0,8);
      const fetched = await Promise.all(batch.map(async ref => {
        if (seen.has(ref.id) || seen.size >= 8192) throw new Error('invalid_manifest');
        seen.add(ref.id);
        const row = await get(`portfolio_${visibility}`,ref.id);
        if (new TextEncoder().encode(row.body.payload).length !== ref.bytes) throw new Error('invalid_content');
        payloadBytes += ref.bytes;
        if (payloadBytes > 128*1024*1024) throw new Error('branch_limit');
        return row.body;
      }));
      for (const doc of fetched) {
        found.push(doc);
        if (doc.id.startsWith('m_')) {
          const manifest = JSON.parse(doc.payload);
          if (manifest.children.length > 16) throw new Error('manifest_fanout');
          queue.push(...manifest.children.map(child=>child.content));
        }
      }
    }
    branches[visibility] = {root,documents:found};
  }
  const fetchedMilliseconds = performance.now()-started;
  const decoded = invoke({action:'decode',...branches});
  const encoded = invoke({action:'encode',dataset:decoded});
  for (const visibility of ['public','private']) {
    if (encoded[visibility].root.id !== branches[visibility].root.id) throw new Error('root_mismatch');
  }
  let staging;
  if (stage) {
    const content=[...branches.public.documents,...branches.private.documents].sort((a,b)=>a.id.localeCompare(b.id));
    if (!Number.isSafeInteger(offset)||offset<0||offset>content.length) throw new Error('invalid_offset');
    const selected=content.slice(offset,offset+count);
    const start=performance.now();
    for(let i=0;i<selected.length;i+=4) await Promise.all(selected.slice(i,i+4).map(stage));
    staging={offset,total:content.length,count:selected.length,milliseconds:performance.now()-start,ids:selected.map(d=>d.id)};
  }
  return {staging,version:head.body.sequence,requests,payloadBytes,fetchedMilliseconds,
    totalMilliseconds:performance.now()-started,
    publicDocuments:branches.public.documents.length,privateDocuments:branches.private.documents.length,
    transactionCount:decoded.public.transactions.length,exactRootParity:true};
}
