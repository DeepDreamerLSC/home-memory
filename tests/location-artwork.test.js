"use strict";
const test=require('node:test'),assert=require('node:assert/strict');
const {LOCATION_ARTWORK,locationArtworkId,isLocationArtworkId,locationArtworkSrc}=require('../miniprogram/utils/location-artwork');
test('approved24 illustration identities use longest name match and a safe neutral fallback',()=>{
  assert.equal(LOCATION_ARTWORK.length,24);assert.equal(new Set(LOCATION_ARTWORK.map(i=>i.id)).size,24);
  for(const [name,id] of [['卧室床头柜','nightstand'],['书房抽屉柜','drawer-unit'],['车内工具箱','toolbox'],['洗手间','bathroom'],['车','car'],['自行车','generic'],['没见过的名字','generic']])assert.equal(locationArtworkId(name),id);
  assert.equal(isLocationArtworkId('../../outside'),false);assert.equal(locationArtworkId('厨房','../../outside'),'kitchen');assert.match(locationArtworkSrc('../../outside'),/\/generic\.png$/);
});
test('an explicit illustration survives name changes; clearing it restores automatic matching',()=>{
  assert.equal(locationArtworkId('书房','toolbox'),'toolbox');assert.equal(locationArtworkId('厨房','toolbox'),'toolbox');assert.equal(locationArtworkId('厨房',null),'kitchen');
});
