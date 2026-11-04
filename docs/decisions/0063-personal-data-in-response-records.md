# 0063 Personal data in response records is masked like request fields

Status: Accepted (2026-11-04). Refines 0004 and 0015.

## Context
A capture of a government member portal, built with the default `--examples masked`, wrote a
profile answer's `memberinfo` object almost as captured. The login form's username, password
and token were masked, and so were `dob` and the email, which a field name or a pattern
recognised. What stayed:
- `name`: `name` is personal only inside a person record. The object's key (`memberinfo`) was
  not a person word and the object held no `username` or `email` key, so it did not count as one.
- `uan`, `bankAccNo` and `aadhaar` (as `XXXX XXXX 1234`): no rule named national or account
  numbers, and the Aadhaar pattern needs all twelve digits.
- `maskedMobileNo` (`987654XXXX`): the phone rule refuses a value with letters, so the X's that
  hide part of the number left the six visible digits.
- `gender`: an ordinary word under an ordinary name. As a code token (`MALE`) in two sessions it
  can also become a schema `enum`, which writes it out a second time.
- Tokens in the query of a same-site URL (`/verify?_HDIV_STATE_=<token>`): URL redaction only
  handled absolute URLs.
- The form's `answer` (a typed captcha answer): no secret word matched it.

## Decision
- An object is a person record also when it sits under `member`, `memberinfo`, `userinfo`,
  `person`, `people` or `employee`, or holds `emailId`, `dob`, `dateOfBirth` or `birthDate`.
  Inside a person record, `name`, `id` and any id-like number (six or more digits, grouped or
  not) are masked keeping their format, whatever the field is called.
- Personal field names (anywhere, by word ending) now include national and account numbers and
  family names: `uan`, `aadhaar`, `ssn`, `pan`, `accNo`, `accountNumber`, `iban`, `fatherName`,
  `husbandName`, `spouseName`, `guardianName`. So do `gender`, `sex` and `maritalStatus`, and any
  name that starts with the word `masked`.
- Special-category data is masked everywhere: any field whose name has the word `handicap`,
  `disability`, `disabled`, `health`, `medical`, `religion`, `caste` or `nationality`, or
  contains `bloodGroup`. `category` (a social category) counts only inside a person record,
  since a product's or an article's category is public. Booleans stay booleans, so a UI
  `disabled: true` is unchanged. Qualifications, the record's other `*Status` fields and dates
  are not special-category data and stay readable.
- Values inside a person record never become a schema `enum`. The schema stage asks
  `isPersonObject` about every object it describes; a person's codes are one person's values,
  not the site's closed set.
- A new personal-data pattern masks partly masked numbers wherever they appear: a token of
  digits, mask characters (`X`, `x`, `*`, `•`), single spaces and `-`, with three mask characters
  in a row and two or more digits (`XXXX XXXX 1234`, `****1234`). The format is kept.
- A same-site URL with a query (`/path?…`) is redacted like an absolute URL. Query values are
  judged by name and by shape, so an opaque token becomes `<redacted: …>`.
- `answer` is a secret word in forms and URLs (a captcha or security-question answer). In JSON
  bodies it stays ordinary data, since Q&A sites post answers as content.

## Gender and special categories
`gender`, `sex` and the special categories above are masked everywhere, not only in person
records. The enum guard asks the
redactor whether a value would change, without knowing about records. If gender were masked only
in examples, two sessions by the same person would still write it as `enum: [FEMALE]`. Masking it
by name also drops a shop's `gender=women` filter from enums and examples. That filter keeps its
type and a masked example of the same format, and the agent learns the values from the site's own
code or pages.

## Consequences
A long number in a user record (a timestamp, a loyalty balance) is masked too; examples show its
format, and schemas keep its type. Status labels in a person record (`panStatus`,
`qualification`, `lastUpdate`) describe the record rather than identify the person and stay
readable; a status about health (`healthStatus`) is masked by its word. A person record's codes
lose their enum, so a generated client accepts any string there. A response field named for
health in a non-personal sense (`healthCheck: "ok"`) is masked too. A partly masked code that is
not personal (`REF XXX-1234`) keeps its letters but loses its digits.
