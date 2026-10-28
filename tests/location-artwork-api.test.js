'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const {handler} = require('../cloudfunctions/locations/lib/handler');
const {createMemoryDb} = require('./helpers/memoryDb');
let seq=0;
function depsFor(db, householdId='hh_artwork') {
  return {db,householdId,now:()=>new Date(1760000000000+(++seq)*1000).toISOString(),genId:()=>`art${++seq}`,digest:s=>s,logger:{log(){}}};
}
async function fixture() {
  const db=createMemoryDb({uniqueIndexes:{locations:[['household_id','parent_id','name_norm']]}}),deps=depsFor(db);
  const ensured=await handler({action:'ensurePath',path:['书房','柜子']},deps);
  assert.equal(ensured.ok,true);
  return {db,deps,room:ensured.nodes[0],node:ensured.nodes[1]};
}
async function snapshot(db) {return (await db.collection('locations').where({}).get()).data;}

test('artwork override round-trips every approved ID and resetting restores automatic matching',async()=>{
  const {db,deps,node}=await fixture(),context={window:{}};
  for(const file of ['spaces','furniture','containers'])vm.runInNewContext(fs.readFileSync(`docs/design/location-artwork-v1/${file}.js`,'utf8'),context);
  const ids=Object.values(context.window).flat().map(x=>x.id);assert.equal(ids.length,24);
  for(const artwork_id of ids){const r=await handler({action:'setArtwork',node_id:node.location_id,artwork_id},deps);assert.equal(r.ok,true,artwork_id);assert.equal(r.node.artwork_id,artwork_id);}
  const list=await handler({action:'list',parent_id:node.location_id},deps);assert.equal(list.node.artwork_id,'generic');
  const reset=await handler({action:'setArtwork',node_id:node.location_id,artwork_id:null},deps);assert.equal(reset.ok,true);assert.equal(reset.node.artwork_id,null);
  assert.deepEqual((await db.collection('items').where({}).get()).data,[]);
});

test('artwork validation refuses omitted, external, malformed and unknown IDs without changing data',async()=>{
  const {db,deps,node}=await fixture();const before=await snapshot(db);
  for(const artwork_id of [undefined,'','https://example.com/a.png','unknown',{},1,' study ']){const r=await handler({action:'setArtwork',node_id:node.location_id,artwork_id},deps);assert.equal(r.error,'INVALID_INPUT');}
  assert.deepEqual(await snapshot(db),before);
});

test('artwork survives rename and move; legacy summaries remain optional and invalid stored IDs are not exposed',async()=>{
  const {db,deps,room,node}=await fixture();const root=await handler({action:'list'},deps);assert.equal(Object.hasOwn(root.children[0],'artwork_id'),false);
  await handler({action:'setArtwork',node_id:node.location_id,artwork_id:'toolbox'},deps);
  const renamed=await handler({action:'rename',node_id:node.location_id,name:'维修用品'},deps);assert.equal(renamed.ok,true);assert.equal(renamed.node.artwork_id,'toolbox');
  const other=await handler({action:'ensurePath',path:['客厅']},deps);
  const moved=await handler({action:'move',node_id:node.location_id,new_parent_id:other.nodes[0].location_id},deps);assert.equal(moved.ok,true);assert.equal(moved.node.artwork_id,'toolbox');
  const children=await handler({action:'list',parent_id:other.nodes[0].location_id},deps);assert.equal(children.children[0].artwork_id,'toolbox');
  await db.collection('locations').doc(room.location_id).update({data:{artwork_id:'https://invalid.test/'}});
  assert.equal(Object.hasOwn((await handler({action:'list',parent_id:room.location_id},deps)).node,'artwork_id'),false);
});

test('artwork rejects home root, foreign, missing and deleted positions without writes',async()=>{
  const {db,deps,node}=await fixture();const root=(await handler({action:'list'},deps)).node;
  const other=await handler({action:'ensurePath',path:['另一个家']},depsFor(db,'hh_other'));
  let before=await snapshot(db);
  assert.equal((await handler({action:'setArtwork',node_id:root.location_id,artwork_id:'study'},deps)).error,'INVALID_INPUT');
  for(const node_id of ['missing',other.nodes[0].location_id])assert.equal((await handler({action:'setArtwork',node_id,artwork_id:'study'},deps)).error,'NOT_FOUND');
  assert.deepEqual(await snapshot(db),before);
  await db.collection('locations').doc(node.location_id).remove();before=await snapshot(db);
  assert.equal((await handler({action:'setArtwork',node_id:node.location_id,artwork_id:'study'},deps)).error,'NOT_FOUND');
  assert.deepEqual(await snapshot(db),before);
});

test('artwork uses shared-household markers and fails closed for stale scope',async()=>{
  const {db,deps,node}=await fixture();deps.householdShared=true;deps.scopeRevision=3;const before=await snapshot(db);
  assert.equal((await handler({action:'setArtwork',node_id:node.location_id,artwork_id:'study'},deps)).error,'FAMILY_SWITCHED');
  assert.equal((await handler({action:'setArtwork',node_id:node.location_id,artwork_id:'study',expected_household_id:deps.householdId,expected_scope_revision:2},deps)).error,'FAMILY_STALE_SCOPE');
  assert.deepEqual(await snapshot(db),before);
  assert.equal((await handler({action:'setArtwork',node_id:node.location_id,artwork_id:'study',expected_household_id:deps.householdId,expected_scope_revision:3},deps)).ok,true);
});

test('artwork rejects frozen node, ancestor and checkpoint-owned detached descendant',async()=>{
  for(const mode of ['self','ancestor','detached']){
    const {db,deps,room,node}=await fixture();
    await db.collection('locations').doc(mode==='self'?node.location_id:room.location_id).update({data:{deleting:{subtree_node_ids:[room.location_id,node.location_id]}}});
    if(mode==='detached')await db.collection('locations').doc(node.location_id).update({data:{parent_id:'missing'}});
    const before=await snapshot(db);const r=await handler({action:'setArtwork',node_id:node.location_id,artwork_id:'study'},deps);
    assert.equal(r.error,'INVALID_INPUT');assert.equal(r.detail.reason,'deleting');assert.deepEqual(await snapshot(db),before);
  }
});
