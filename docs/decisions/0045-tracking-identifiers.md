# 0045 Visitor, device and client ids are redacted unless constant

Status: Accepted (2026-10-30). Refines 0004 and 0015.

## Context
Redaction masked values by credential names (0004), personal field names (0015) and formats, but
not identifiers that follow one visitor, browser or device. On a real retail capture Nike's
`x-nike-visitorid` header and the `visitorId` and `adobeMarketingCloudId` body fields of its
analytics events, and a third-party review widget's `uid`, were written to the specs as captured
with `examples: masked`. Each is a per-person tracking identifier: it ties the captured traffic
to one person's browser across sites and sessions, as an email would.

## Decision
- Names of tracking identifiers are recognised like personal field names
  (`isTrackingIdName` in `personal-data.ts`): names ending in `visitorid`, `deviceid`,
  `anonymousid`, `anonid`, `clientid`, `browserid`, `trackingid`, `marketingcloudid` or
  `experiencecloudid` on word boundaries (`x-nike-visitorid`, `visitor_id`, `deviceId`), and the
  short names `cid`, `uid`, `_ga`, `ecid` and `mcid` only as whole names, so `guid` or `acid` do
  not count. Session ids were already secrets by name and stay so.
- Their values count as rule 2 of the redactor: replaced by their shape in headers, query
  strings, forms, JSON bodies (strings and numbers) and examples, learnt so the same value is
  removed wherever else it appears (in URLs, echoed in responses), and kept only when identical
  in every session of a capture with two or more, as publishable keys are. An id the site ships
  to everyone (an OAuth `clientId`) is constant; a visitor id differs per browser profile.
- They never become enum values or constant header defaults, because both already ask the
  redactor.

## Consequences
In a single-session capture a constant `clientId` is redacted too, the same trade-off publishable
keys make; a second capture brings it back. Names outside the list (`fp`, `vid`, vendor-specific
cookies are already redacted as cookies) still rely on the format and blob rules.
