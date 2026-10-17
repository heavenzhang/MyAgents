import {readFileSync} from 'node:fs';
import {expect,it} from 'vitest';
import {remoteAssetRequestSchema,remoteAssetResultSchema} from './remoteAssets';
it('matches the Rust asset fixture, including closed scope and canonical bounded chunks',()=>{
 const fixture=JSON.parse(readFileSync(new URL('../../src-tauri/host-management-protocol/tests/fixtures/remote-assets-v1.json',import.meta.url),'utf8'));
 for(const value of fixture.requests) expect(remoteAssetRequestSchema.safeParse(value).success,JSON.stringify(value).slice(0,120)).toBe(true);
 for(const value of fixture.results) expect(remoteAssetResultSchema.safeParse(value).success,JSON.stringify(value).slice(0,120)).toBe(true);
 for(const value of fixture.invalidRequests) expect(remoteAssetRequestSchema.safeParse(value).success,JSON.stringify(value).slice(0,120)).toBe(false);
 for(const value of fixture.invalidResults) expect(remoteAssetResultSchema.safeParse(value).success,JSON.stringify(value).slice(0,120)).toBe(false);
});
