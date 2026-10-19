import assert from "node:assert/strict";
import { test } from "node:test";
import { dailyBalanceHistory } from "../functions/shared/balance-history.ts";
import { accountBalances } from "../functions/shared/balances.ts";
const account={id:"a",household_id:"home",currency:"USD",opening_balance:10000,opening_date:"2026-10-01"};
const tx=(date,amount,extra={})=>({account_id:"a",date,amount,...extra});
const report=(date,balance,extra={})=>({household_id:"home",account_id:"a",currency:"USD",date,balance,observed_at:1,source:"plaid",...extra});

test("current balance is the last source observation, even during partial imports and manual edits",()=>{
  const reports=[report("2026-10-02",12000),report("2026-10-03",11000),report("2026-10-03",11500,{observed_at:2}),
    report("2026-10-04",999999,{household_id:"other"}),report("2026-10-04",999999,{currency:"EUR"})];
  assert.equal(accountBalances([account],[tx("2026-10-04",-100000)],reports).get("a"),11500);
  assert.equal(accountBalances([account],[],reports).get("a"),11500);
});

test("history estimates backwards before the first report and forwards across gaps, resetting on reported dates",()=>{
  const transactions=[tx("2026-10-01",100),tx("2026-10-02",-200),tx("2026-10-03",-300),tx("2026-10-04",400),tx("2026-10-05",-50)];
  const rows=dailyBalanceHistory(account,transactions,[report("2026-10-03",5000),report("2026-10-05",6000)],"2026-10-06");
  assert.deepEqual(rows.map(p=>[p.date,p.balance,p.estimated]),[
    ["2026-10-01",5500,true],["2026-10-02",5300,true],["2026-10-03",5000,false],
    ["2026-10-04",5400,true],["2026-10-05",6000,false],["2026-10-06",6000,true],
  ]);
  assert.equal(rows[2].source,"plaid");
  assert.deepEqual(dailyBalanceHistory(account,transactions,[report("2026-10-03",5000),report("2026-10-05",6000)],"2026-10-06","2026-10-04"),rows.slice(3));
});

test("estimates retain signed transfers and hidden real entries, excluding pending, future and bank adjustments",()=>{
  const transactions=[tx("2026-10-02",-100,{transfer_id:"transfer"}),tx("2026-10-02",50,{hidden:true}),
    tx("2026-10-02",-999,{pending:true}),tx("2026-10-02",999,{adjustment:true,description:"Bank balance reconciliation",external_id:"balance-link"}),
    tx("2026-10-03",999),tx("2026-10-02",999,{account_id:"other"})];
  assert.deepEqual(dailyBalanceHistory(account,transactions,[],"2026-10-02").map(p=>p.balance),[10000,9950]);
  const credit={...account,opening_balance:-10000};
  assert.equal(dailyBalanceHistory(credit,[tx("2026-10-02",-500),tx("2026-10-03",2000)],[report("2026-10-03",-8500)],"2026-10-03")[0].balance,-10000);
});

test("newest same-day observation wins; another household, currency or future report cannot anchor history",()=>{
  const rows=dailyBalanceHistory(account,[],[report("2026-10-02",12000),report("2026-10-02",13000,{observed_at:2}),
    report("2026-10-02",99,{household_id:"other"}),report("2026-10-02",99,{currency:"EUR"}),report("2026-10-04",99)],"2026-10-03");
  assert.deepEqual(rows.map(p=>p.balance),[13000,13000,13000]);
  assert.deepEqual(rows.map(p=>p.estimated),[true,false,true]);
});
