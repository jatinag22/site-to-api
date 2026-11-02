import type { ExtractSpec, HtmlExtractSpec } from 'site-to-api-runtime'
import type { Product, Question, Story } from './fixtures'
import { extract } from 'site-to-api-runtime'
import { describe, expect, it } from 'vitest'
import { parseHtml } from './dom'
import { productTable, profileTable, questionList, searchResults, storyTable } from './fixtures'
import { repeatedGroups } from './groups'
import { applyExtractSpec, inferExtraction } from './index'
import { distinctGroups } from './records'

const html = (text: string): { text: string, mimeType: string } => ({ text, mimeType: 'text/html' })

function htmlSpec(spec: ExtractSpec | undefined): HtmlExtractSpec {
  if (spec?.kind !== 'html')
    throw new Error('expected an html spec')
  return spec
}

function story(id: number, title: string, overrides: Partial<Story> = {}): Story {
  return {
    id,
    title,
    url: `https://${title.toLowerCase().replace(/\W+/g, '-')}.example/post`,
    site: `${title.split(' ')[0]?.toLowerCase() ?? 'x'}.example`,
    score: (id % 97) + 1,
    user: `user${id % 13}`,
    hoursAgo: (id % 11) + 1,
    comments: id % 7,
    ...overrides,
  }
}

const frontOne = storyTable([
  story(7001, 'Quiet Kettles'),
  story(7002, 'Paper Boats'),
  story(7003, 'Hiring Bakers', { score: null }),
  story(7004, 'Tiny Lamps', { score: 1, comments: 1 }),
])
const frontTwo = storyTable([
  story(7101, 'Glass Gardens'),
  story(7102, 'Slow Trains'),
  story(7103, 'Blue Maps'),
], 2)

describe('records that span sibling rows (Hacker News layout)', () => {
  const result = inferExtraction([
    html(frontOne),
    html(frontTwo),
  ], { minSamples: 2 })
  const spec = htmlSpec(result?.spec)

  it('keys each story on its repeated row and reads the rows after it', () => {
    expect(spec.records).toBe('#box > td:nth-of-type(1) > table:nth-of-type(1) > tr.athing.submission')
    expect(spec.recordsName).toBe('submissions')
    expect(spec.fields.score?.selector).toBe(':scope + tr:not(.athing.submission) span.score')
  })

  it('names fields after the markup and drops links built from the id', () => {
    expect(Object.keys(spec.fields)).toEqual([
      'id',
      'rank',
      'title',
      'url',
      'site',
      'score',
      'user',
      'ageDate',
      'age',
      'comments',
    ])
    expect(spec.fields.id).toMatchObject({ selector: '', attr: 'id', type: 'integer' })
  })

  it('extracts one record per story from a new page, job ads included, the same in the runtime', () => {
    const fresh = storyTable([
      story(9001, 'Warm Bread'),
      story(9002, 'Hiring Potters', { score: null }),
      story(9003, 'Old Clocks', { comments: 0 }),
    ])
    const records = applyExtractSpec(fresh, spec)
    expect(records).toHaveLength(3)
    expect(records[0]).toEqual({
      id: 9001,
      rank: 1,
      title: 'Warm Bread',
      url: 'https://warm-bread.example/post',
      site: 'warm.example',
      score: 78,
      user: 'user5',
      ageDate: '2030-01-01T04:00:00',
      age: '4 hours ago',
      comments: 6,
    })
    expect(records[1]).toMatchObject({
      id: 9002,
      title: 'Hiring Potters',
      score: null,
      user: null,
      comments: null,
      age: '5 hours ago',
    })
    // `discuss` stands where a count of zero would be.
    expect(records[2]).toMatchObject({ id: 9003, comments: null })
    const runtime = extract(fresh, spec)
    expect(Array.isArray(runtime) && runtime.map(record => [record.id, record.score ?? null])).toEqual([
      [9001, 78],
      [9002, null],
      [9003, 80],
    ])
  })

  it('works from one sample, as tables do', () => {
    const single = htmlSpec(inferExtraction([
      html(frontOne),
    ], { minSamples: 2 })?.spec)
    expect(single.records).toContain('tr.athing.submission')
    expect(applyExtractSpec(frontTwo, single)).toHaveLength(3)
  })
})

describe('profile pages', () => {
  const pages = [
    profileTable({
      name: 'quill',
      created: 'March 3, 2011',
      day: '2011-03-03',
      karma: 1204,
      about: 'Makes paper.',
    }),
    profileTable({
      name: 'brook',
      created: 'June 9, 2015',
      day: '2015-06-09',
      karma: 88,
      about: 'Rows boats.',
    }),
  ]

  it('reads the labelled rows and takes no year from the date link as an id', () => {
    const spec = htmlSpec(inferExtraction(pages.map(html), { minSamples: 2 })?.spec)
    expect(spec).toMatchObject({ records: ':root', many: false })
    expect(Object.keys(spec.fields)).toEqual(['user', 'created', 'karma', 'about'])
    expect(applyExtractSpec(pages[0] ?? '', spec)).toEqual([
      {
        user: 'quill',
        created: '2011-03-03',
        karma: 1204,
        about: 'Makes paper.',
      },
    ])
  })
})

describe('card lists with schema.org types (Stack Overflow layout)', () => {
  const ask = (id: number, title: string, votes: number, answers: number): Question => ({
    id,
    title,
    votes,
    answers,
    tag: `tag${id % 5}`,
    author: `author${id % 9}`,
  })
  const first = questionList([
    ask(501, 'Why is the sky blue', 3, 1),
    ask(502, 'How do magnets work', -1, 0),
    ask(503, 'What is a lemma', 12, 4),
  ], ['Cats', 'Dogs', 'Owls'])
  // The same questions a minute later, with new votes: the list was fetched twice.
  const again = questionList([
    ask(501, 'Why is the sky blue', 4, 1),
    ask(502, 'How do magnets work', -1, 1),
    ask(503, 'What is a lemma', 13, 4),
  ], ['Cats', 'Dogs', 'Owls'])

  it('picks the question cards over the sidebar and names them after their type', () => {
    const spec = htmlSpec(inferExtraction([
      html(first),
      html(again),
    ], { minSamples: 2 })?.spec)
    expect(spec.records).toBe('div[itemprop="mainEntity"] > div.bb.bc-black-200')
    expect(spec.recordsName).toBe('questions')
    expect(Object.keys(spec.fields)).toEqual(expect.arrayContaining([
      'postId',
      'upvoteCount',
      'answerCount',
      'title',
      'url',
    ]))
    expect(applyExtractSpec(first, spec)[0]).toMatchObject({
      postId: 501,
      upvoteCount: 3,
      title: 'Why is the sky blue',
      url: '/questions/501/q',
    })
  })
})

describe('search results among filters (marketplace layout)', () => {
  const item = (code: string, title: string, price: string, rating: string, sponsored = false): Product => ({
    code,
    title,
    price,
    rating,
    sponsored,
  })
  const filters = [
    'Brand A',
    'Brand B',
    'Under 500',
    'Over 500',
    'Blue',
    'Red',
    'Green',
    'Large',
    'Small',
  ]
  const kettles = searchResults('kettle', [
    item('K1AB23CD45', 'Steel Kettle', '1,299', '4.1', true),
    item('K2AB23CD45', 'Glass Kettle', '899', '3.8'),
    item('K3AB23CD45', 'Travel Kettle', '650', '4.5'),
  ], filters)
  const lamps = searchResults('lamp', [
    item('L1AB23CD45', 'Desk Lamp', '450', '4.0'),
    item('L2AB23CD45', 'Floor Lamp', '2,450', '3.2', true),
  ], filters)

  it('keys the cards on their shared marker attribute although layout classes differ', () => {
    const spec = htmlSpec(inferExtraction([
      html(kettles),
      html(lamps),
    ], { minSamples: 2 })?.spec)
    expect(spec.records).toMatch(/^div\.main-slot > div\[(?:role="listitem"|data-component-type="search-result")\]$/)
    expect(applyExtractSpec(kettles, spec)[0]).toMatchObject({
      code: 'K1AB23CD45',
      url: '/item/K1AB23CD45?q=kettle',
      title: 'Steel Kettle',
      rating: 4.1,
      price: 1299,
    })
  })
})

describe('tables', () => {
  it('names the records after the table and leaves a layout table alone', () => {
    const rows = [
      {
        id: 1,
        slug: 'a',
        name: 'Ann',
        price: '10.00',
        stock: '1',
        listed: '01/02/2024',
      },
      {
        id: 2,
        slug: 'b',
        name: 'Bo',
        price: '12.00',
        stock: '2',
        listed: '02/02/2024',
      },
    ]
    const page = `<table id="layout"><tr><td>${productTable('Kitchen', rows)}</td></tr><tr><td>footer</td></tr></table>`
    const spec = htmlSpec(inferExtraction([
      html(page),
    ], { minSamples: 2 })?.spec)
    expect(spec.records).toBe('#products tr:has(> td)')
    expect(spec.recordsName).toBe('listings')
  })
})

describe('tables with heading rows (a statement grouped by day)', () => {
  const statement = (seed: number, sizes: number[]): string => {
    let k = seed * 100
    const rows = sizes.map((count, day) => `<tr class="day"><td colspan="3">Day ${day + 1}</td></tr>${Array.from({ length: count }, () => {
      k++
      return `<tr><td>Payee ${String.fromCharCode(65 + (k % 26))}${k}</td><td>${k * 3}.00</td><td>R${k % 7}</td></tr>`
    }).join('')}`).join('')
    return `<html><body><table id="t"><tr><th>Name</th><th>Amount</th><th>Ref</th></tr>${rows}</table></body></html>`
  }

  it('reads every entry as a row when each day has as many', () => {
    const spec = htmlSpec(inferExtraction([
      html(statement(1, [4, 4, 4])),
      html(statement(2, [4, 4, 4])),
    ], { minSamples: 2 })?.spec)
    expect(spec.records).toBe('#t tr:has(> td + td)')
    expect(Object.keys(spec.fields)).toEqual(['name', 'amount', 'ref'])
    expect(applyExtractSpec(statement(3, [4, 4, 4]), spec)).toHaveLength(12)
  })

  it('reads every entry as a row when days have different numbers of entries', () => {
    const spec = htmlSpec(inferExtraction([
      html(statement(1, [1, 3, 2, 2, 1, 4])),
      html(statement(2, [2, 1, 4])),
    ], { minSamples: 2 })?.spec)
    expect(Object.keys(spec.fields)).toEqual(['name', 'amount', 'ref'])
    const records = applyExtractSpec(statement(1, [1, 3, 2, 2, 1, 4]), spec)
    expect(records).toHaveLength(13)
    expect(records[0]).toEqual({ name: 'Payee X101', amount: 303, ref: 'R3' })
  })
})

describe('distinctGroups', () => {
  it('keeps one group per set of records, a class before a marker, then the shortest', () => {
    const page = (n: number) => `<html><body><div id="r">${Array.from({ length: n }, (_, i) => `<div class="result" data-asin="B0DQ212K${i}" data-type="card">${i}</div>`).join('')}</div></body></html>`
    const samples = [
      parseHtml(page(3)),
      parseHtml(page(4)),
    ]
    const groups = repeatedGroups(samples)
    expect(groups.map(group => group.selector)).toEqual(['#r > div.result', '#r > div[data-asin]', '#r > div[data-type="card"]'])
    expect(distinctGroups([...groups].reverse(), samples).map(group => group.selector)).toEqual(['#r > div.result'])
  })

  it('ranks a class with a `__` part, which may be a build hash, after a marker', () => {
    const page = (n: number) => `<html><body><ul id="r">${Array.from({ length: n }, (_, i) => `<li class="row__klorrw" data-density="normal">${i}</li>`).join('')}</ul></body></html>`
    const samples = [
      parseHtml(page(3)),
      parseHtml(page(4)),
    ]
    expect(distinctGroups(repeatedGroups(samples), samples).map(group => group.selector)).toEqual(['#r > li[data-density="normal"]'])
  })
})

describe('fields named like Object members', () => {
  it('keeps an optional `constructor` column in specs and generated-client records', () => {
    const results = (seed: number) => `<html><body><table id="r"><tr><th>Driver</th><th>Constructor</th></tr>${[1, 2, 3, 4].map(i => `<tr><td>D${seed}${i}</td><td>${i === 2
      ? ''
      : `<a href="/c/${seed}${i}">C${seed}${i}</a>`}</td></tr>`).join('')}</table></body></html>`
    const spec = htmlSpec(inferExtraction([
      html(results(1)),
      html(results(2)),
    ], { minSamples: 2 })?.spec)
    expect(Object.keys(spec.fields)).toContain('constructor')
    const runtime = extract(results(3), spec)
    expect(Array.isArray(runtime) && Object.hasOwn(runtime[1] ?? {}, 'constructor')).toBe(false)
    expect(Array.isArray(runtime) && runtime[1]?.constructor).toBeUndefined()
  })
})

describe('pages with namespaced tags and odd class names', () => {
  // An Amazon product page logs with `<dptags:queryLogOperation>`; tags and classes must be escaped.
  const page = (seed: number): string => `<html><body><dptags:queryLogOperation operation="q${seed}"></dptags:queryLogOperation>
<ul id="list">${[1, 2, 3].map(i => `<li class="item w-1/2"><dptags:price value="${seed * 10 + i}">${seed * 10 + i}</dptags:price><span class="name:x">${['Kettle', 'Lamp', 'Mug'][i - 1]} ${['red', 'blue'][seed % 2]}</span></li>`).join('')}</ul></body></html>`

  it('infers a spec the runtime accepts and reads like inference', () => {
    const samples = [
      page(1),
      page(2),
    ]
    const spec = htmlSpec(inferExtraction(samples.map(html), { minSamples: 2 })?.spec)
    expect(spec.records).toBe('#list > li.item')
    expect(Object.values(spec.fields).map(field => field.selector)).toContain('dptags\\:price')
    const runtime = extract(page(3), spec)
    expect(runtime).toEqual(applyExtractSpec(page(3), spec))
    expect(Array.isArray(runtime) && runtime.map(record => Object.values(record))).toEqual([
      [31, 'Kettle blue'],
      [32, 'Lamp blue'],
      [33, 'Mug blue'],
    ])
  })
})
