import {readFileSync} from 'node:fs';
import {expect,it} from 'vitest';
import {remoteMobileRequestSchema,remoteMobileResultSchema} from './remoteMobile';
import {remoteSessionRequestSchema} from './remoteSession';
it('matches closed Rust mobile admission fixtures and keeps legacy v1 frozen',()=>{
 const f=JSON.parse(readFileSync(new URL('../../src-tauri/host-management-protocol/tests/fixtures/remote-mobile-v1.json',import.meta.url),'utf8'));
 for(const value of f.requests){expect(remoteMobileRequestSchema.safeParse(value).success).toBe(true);expect(remoteSessionRequestSchema.safeParse(value).success).toBe(false);}
 for(const value of f.results)expect(remoteMobileResultSchema.safeParse(value).success).toBe(true);
 for(const value of f.invalidRequests)expect(remoteMobileRequestSchema.safeParse(value).success).toBe(false);
 for(const value of f.invalidResults)expect(remoteMobileResultSchema.safeParse(value).success).toBe(false);
});
