# Task 5 Report

## Status
Completed

## Commits made
- `b9f3dcc` chore: add entrypoint and Dockerfile

## Test summary
All 4 test files passed (4 tests total) successfully.

## Concerns
NONE

## Build Fix Report
**Status:** Fixed `npm run build` failure caused by tests leaking out of `rootDir` and obsoleted TS `moduleResolution` settings.

**Changes made:**
- Changed `module` and `moduleResolution` to `node16` in `tsconfig.json` to properly support TS 7 resolution and correctly type Hono and standard JS globals.
- Added `@types/node` explicitly under `types`.
- Created an explicit `types/global.d.ts` extending `Response` to fix a Hono generic typing inconsistency under TS 7.
- Excluded `test/**/*` from default `include` in `tsconfig.json` to keep `dist/` clean and fix the `rootDir` mismatch error.
- (Optional, but cleanly provided) created `.gitignore` to prevent output artifacts like `dist/` and `node_modules/` from being accidentally tracked.

**Verifications:**
`npm run build`: Exit 0
```
> qwen-api-web@1.0.0 build
> tsc
```

`ls dist/`: (No test files or extra folders included)
```
config.js
index.js
qwen
routes
server.js
```

`npm test`: All tests pass cleanly. Exit 0
```
> qwen-api-web@1.0.0 test
> vitest run
 RUN  v4.1.11 /Users/ankit/Developer/myProject/qwen-api-web
 Test Files  4 passed (4)
      Tests  4 passed (4)
```