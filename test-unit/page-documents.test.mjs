import assert from "node:assert/strict";
import { test } from "node:test";
import { allDocumentPages } from "../functions/shared/page-documents.ts";

test("nightly aggregates include transactions beyond the former 10,000-row cutoff", async () => {
  const expected = Array.from({length:20001},(_,id)=>({id,amount:1}));
  const actual = await allDocumentPages(async cursor => {
    const start = Number(cursor ?? 0), end = Math.min(start + 200,expected.length);
    return {documents:expected.slice(start,end),nextCursor:end < expected.length ? String(end) : null};
  });
  assert.equal(actual.reduce((sum,row)=>sum+row.amount,0),20001);
  assert.deepEqual(actual,expected);
});

test("query failures and repeated cursors reject instead of returning partial financial history",async()=>{
  await assert.rejects(allDocumentPages(async cursor=>{
    if(cursor)throw new Error("connection failed");
    return {documents:[{amount:1}],nextCursor:"next"};
  }),/connection failed/);
  await assert.rejects(allDocumentPages(async()=>({documents:[{amount:1}],nextCursor:"same"})),/repeated a cursor/);
});
