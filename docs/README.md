# Easyrent REST API Reference

Source files from the WINTERSTEIGER Easyrent REST adapter (Progress OpenEdge / Apache Camel CXF).
These define the complete REST API surface exposed by Easyrent's `/easyrest/rest` base path.

## Files

- **resourceModel.xml** — Every REST endpoint: path, HTTP verb, query/path/header params, and content types.
- **mapping.xml** — How request params and body payloads map to internal procedure parameters, and how responses map back to HTTP status + body.
- **spring.xml** — Server wiring: base address (`/easyrest`), binding strategy, error handling config.

## How to read them

`resourceModel.xml` is the most useful. Each `<prgs:resource>` block is one endpoint. Look at `path`, `verb`, and the `<prgs:param>` entries for the exact param names and whether they're QUERY, PATH, HEADER, or COOKIE.

`mapping.xml` shows which params get special treatment. For example, POST endpoints map `http.body` to a named procedure parameter (`reservationData`, `getavailData`, etc.). GET endpoints with pagination map `top`/`skip` to `piTop`/`piSkip`. All responses map `retVal` → HTTP status code and `returnObject` → response body.

## Origin

Extracted from Easyrent version: _[TODO: fill in version]_
Instance: _[TODO: fill in which shop/server]_
Date: _[TODO: fill in extraction date]_

## Notes

- These files are reference only — not parsed at runtime.
- The typed REST client in `src/integrations/easyrent/restClient.ts` is the runtime abstraction.
- If Easyrent is updated, re-extract these files and diff against the originals to catch new/changed endpoints.