import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "../src/lib/uuid.ts";

test("workspace IDs remain UUID v4 when HTTP disables crypto.randomUUID",()=>{
  const original=Object.getOwnPropertyDescriptor(globalThis,"crypto");
  const getRandomValues=crypto.getRandomValues.bind(crypto);
  try {
    Object.defineProperty(globalThis,"crypto",{configurable:true,value:{getRandomValues}});
    const ids=new Set(Array.from({length:100},()=>randomUUID()));
    assert.equal(ids.size,100);
    for(const id of ids)assert.match(id,/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  } finally {Object.defineProperty(globalThis,"crypto",original);}
});
