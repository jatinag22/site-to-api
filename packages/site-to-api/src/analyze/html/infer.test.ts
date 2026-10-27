import type { ExtractSpec, HtmlExtractSpec } from '@site-to-api/runtime'
import { describe, expect, it } from 'vitest'
import { cardGrid, nextDataPage, productDetail, productTable } from './fixtures'
import { applyExtractSpec, inferExtraction } from './index'

const html = (text: string): { text: string, mimeType: string } => ({ text, mimeType: 'text/html' })
const plain = (text: string, mimeType = 'text/plain'): { text: string, mimeType: string } => ({ text, mimeType })

const kitchen = productTable('Kitchen', [
  {
    id: 1001,
    slug: 'blue-kettle',
    name: 'Blue Kettle',
    price: '1,299.00',
    stock: '12',
    listed: '05/03/2024',
  },
  {
    id: 1002,
    slug: 'red-pan',
    name: 'Red Pan',
    price: '899.00',
    stock: '3',
    listed: '16/03/2024',
  },
  {
    id: 1003,
    slug: 'steel-ladle',
    name: 'Steel Ladle',
    price: '249.50',
    stock: '0',
    listed: '01/04/2024',
  },
])
const garden = productTable('Garden', [
  {
    id: 2001,
    slug: 'hose',
    name: 'Garden Hose',
    price: '2,150.00',
    stock: '7',
    listed: '11/02/2024',
  },
  {
    id: 2002,
    slug: 'rake',
    name: 'Rake',
    price: '540.00',
    stock: '25',
    listed: '28/02/2024',
  },
])

const kettle = productDetail({
  name: 'Blue Kettle',
  brand: 'Acme',
  price: '1,299',
  inStock: 'Yes',
  seller: 'Acme Retail',
  rating: '4.5',
  sku: 'SKU-1001',
})
const hose = productDetail({
  name: 'Garden Hose',
  brand: 'Hoseco',
  price: '2,150',
  inStock: 'No',
  seller: 'Green Things',
  rating: '3.9',
  sku: 'SKU-2001',
})

const kettles = cardGrid('kettle', [
  {
    id: 11,
    title: 'Blue Kettle',
    price: '12.50',
    badge: 'New',
  },
  {
    id: 12,
    title: 'Red Kettle',
    price: '9.99',
    badge: null,
  },
  {
    id: 13,
    title: 'Glass Kettle',
    price: '24.00',
    badge: 'Sale',
  },
])
const pans = cardGrid('pan', [
  {
    id: 21,
    title: 'Iron Pan',
    price: '30.00',
    badge: null,
  },
  {
    id: 22,
    title: 'Steel Pan',
    price: '18.75',
    badge: 'New',
  },
])

function htmlSpec(spec: ExtractSpec | undefined): HtmlExtractSpec {
  if (spec?.kind !== 'html')
    throw new Error('expected an html spec')
  return spec
}

describe('inferExtraction: tables', () => {
  it('extracts a products table with header names, rupee prices, link ids and day-first dates', () => {
    const result = inferExtraction([
      html(kitchen),
      html(garden),
    ], { minSamples: 2 })
    expect(result?.confidence).toBe('high')
    expect(result?.samples).toBe(2)
    const spec = htmlSpec(result?.spec)
    expect(spec.records).toBe('#products tr:has(> td)')
    expect(spec.many).toBe(true)
    expect(Object.keys(spec.fields)).toEqual([
      'sku',
      'product',
      'productUrl',
      'productId',
      'price',
      'inStock',
      'listedOn',
    ])
    expect(spec.fields.price).toEqual({
      selector: 'td.price',
      attr: null,
      pattern: '₹\\s*([+-]?\\d[\\d,]*(?:\\.\\d+)?)',
      type: 'number',
      optional: false,
    })
    expect(spec.fields.productId).toMatchObject({ attr: 'href', pattern: '^/products/(\\d+)', type: 'integer' })
    expect(applyExtractSpec(kitchen, spec)[0]).toEqual({
      sku: 'SKU-1001',
      product: 'Blue Kettle',
      productUrl: '/products/1001-blue-kettle',
      productId: 1001,
      price: 1299,
      inStock: 12,
      listedOn: '2024-03-05',
    })
    expect(applyExtractSpec(garden, spec)).toHaveLength(2)
  })

  it('accepts a single table sample with low confidence', () => {
    const result = inferExtraction([
      html(kitchen),
    ], { minSamples: 2 })
    expect(result?.confidence).toBe('low')
    expect(htmlSpec(result?.spec).fields.price?.type).toBe('number')
  })

  it('stays low when fewer than minSamples samples were seen', () => {
    expect(inferExtraction([
      html(kitchen),
      html(garden),
    ], { minSamples: 3 })?.confidence).toBe('low')
  })
})

describe('inferExtraction: detail pages', () => {
  it('reads definition lists, two-column tables and "Label: value" text from one sample', () => {
    const result = inferExtraction([
      html(kettle),
    ], { minSamples: 2 })
    expect(result?.confidence).toBe('low')
    const spec = htmlSpec(result?.spec)
    expect(spec).toMatchObject({ records: ':root', many: false })
    expect(spec.fields.price).toEqual({
      selector: 'dt:contains("Price") + dd',
      attr: null,
      pattern: '₹\\s*([+-]?\\d[\\d,]*)',
      type: 'integer',
      optional: false,
    })
    expect(spec.fields.rating?.pattern).toBe('([+-]?\\d[\\d,]*(?:\\.\\d+)?)\\s*/\\s*5')
    expect(applyExtractSpec(kettle, spec)).toEqual([
      {
        brand: 'Acme',
        price: 1299,
        available: true,
        seller: 'Acme Retail',
        rating: 4.5,
        sku: 'SKU-1001',
      },
    ])
  })

  it('adds positions that vary between samples and names them from classes', () => {
    const result = inferExtraction([
      html(kettle),
      html(hose),
    ], { minSamples: 2 })
    expect(result?.confidence).toBe('high')
    const spec = htmlSpec(result?.spec)
    expect(spec.fields.productTitle).toEqual({
      selector: 'h1.product-title',
      attr: null,
      pattern: null,
      type: 'string',
      optional: false,
    })
    expect(applyExtractSpec(hose, spec)[0]).toMatchObject({ productTitle: 'Garden Hose', available: false, rating: 3.9 })
    // Navigation, footer and the "Add to cart" button are the same in both samples: template.
    expect(Object.values(spec.fields).some(field => field.selector.includes('nav') || field.selector.includes('button'))).toBe(false)
  })
})

describe('inferExtraction: repeated structures', () => {
  it('finds a card grid across samples, with an optional badge and template text left out', () => {
    const result = inferExtraction([
      html(kettles),
      html(pans),
    ], { minSamples: 2 })
    expect(result?.confidence).toBe('high')
    const spec = htmlSpec(result?.spec)
    expect(spec.records).toBe('section.grid > article.card')
    // The link's id equals data-id, so only one `id` field is kept.
    expect(Object.keys(spec.fields)).toEqual([
      'id',
      'image',
      'title',
      'titleUrl',
      'price',
      'badge',
    ])
    expect(spec.fields.badge?.optional).toBe(true)
    expect(applyExtractSpec(pans, spec)).toEqual([
      {
        id: 21,
        image: '/img/21.jpg',
        title: 'Iron Pan',
        titleUrl: '/p/21',
        price: 30,
        badge: null,
      },
      {
        id: 22,
        image: '/img/22.jpg',
        title: 'Steel Pan',
        titleUrl: '/p/22',
        price: 18.75,
        badge: 'New',
      },
    ])
  })

  it('does not guess repeated structures from a single sample', () => {
    expect(inferExtraction([
      html(kettles),
    ], { minSamples: 2 })).toBeNull()
  })
})

describe('inferExtraction: busy pages', () => {
  /** A results page with a long menu, many cards and lots of static filler. */
  function busyPage(seed: number): string {
    const menu = Array.from({ length: 120 }, (_, i) => `<li class="nav-item"><a href="/c/${i}">Category ${i}</a></li>`).join('')
    const cards = Array.from({ length: 40 }, (_, i) => `<div class="card"><h3 class="t">Item ${seed}-${i}</h3><span class="p">₹${seed * 100 + i}</span><div class="seller"><span>Sold by</span><b>Shop ${(i * seed) % 9}</b></div></div>`).join('')
    const filler = Array.from({ length: 200 }, (_, i) => `<div class="f"><p>Static text ${i}</p><span>${i}</span></div>`).join('')
    return `<html><body><header><ul class="nav">${menu}</ul></header><main><h1>Results ${seed}</h1><div class="grid">${cards}</div>${filler}</main></body></html>`
  }

  it('picks the records that change between samples over a menu that never does', () => {
    const result = inferExtraction([1, 2, 3].map(seed => html(busyPage(seed))), { minSamples: 2 })
    const spec = htmlSpec(result?.spec)
    expect(spec.records).toBe('div.grid > div.card')
    expect(Object.keys(spec.fields)).toEqual(['t', 'p', 'seller'])
    expect(spec.fields.p).toMatchObject({ type: 'integer', pattern: '₹\\s*([+-]?\\d[\\d,]*)' })
  })
})

describe('inferExtraction: text', () => {
  it('reads CSV with a header row and quoted thousands', () => {
    const first = 'symbol,name,price,listed\nACME,Acme Corp,"1,250.50",2024-03-01\nGLOBX,Globex,98.10,2024-03-02\n'
    const second = 'symbol,name,price,listed\nINIT,Initech,12.00,2024-04-11\n'
    const result = inferExtraction([
      plain(first, 'text/csv'),
      plain(second, 'text/csv'),
    ], { minSamples: 2 })
    expect(result?.confidence).toBe('high')
    expect(result?.spec).toEqual({
      kind: 'text',
      layout: 'delimited',
      delimiter: ',',
      header: true,
      pattern: null,
      fields: {
        symbol: {
          column: 0,
          group: null,
          type: 'string',
          optional: false,
        },
        name: {
          column: 1,
          group: null,
          type: 'string',
          optional: false,
        },
        price: {
          column: 2,
          group: null,
          type: 'number',
          optional: false,
        },
        listed: {
          column: 3,
          group: null,
          type: 'date',
          optional: false,
        },
      },
    })
    expect(result && applyExtractSpec(first, result.spec)[0]).toEqual({
      symbol: 'ACME',
      name: 'Acme Corp',
      price: 1250.5,
      listed: '2024-03-01',
    })
  })

  it('reads pipe-delimited text without a header and names columns by position', () => {
    const result = inferExtraction([
      plain('1001|Blue Kettle|1299\n1002|Red Pan|899\n'),
    ], { minSamples: 2 })
    expect(result?.spec).toMatchObject({ layout: 'delimited', delimiter: '|', header: false })
    expect(result && applyExtractSpec('1003|Ladle|10\n', result.spec)).toEqual([
      { field1: 1003, field2: 'Ladle', field3: 10 },
    ])
  })

  it('turns key: value lines into a pattern with named groups', () => {
    const text = 'id: 17 | status: SHIPPED | total: 450.00\nid: 18 | status: PENDING | total: 1200\n'
    const result = inferExtraction([
      plain(text),
    ], { minSamples: 2 })
    expect(result?.spec).toMatchObject({ kind: 'text', layout: 'pattern' })
    expect(result && applyExtractSpec(text, result.spec)).toEqual([
      { id: 17, status: 'SHIPPED', total: 450 },
      { id: 18, status: 'PENDING', total: 1200 },
    ])
  })

  it('turns blank-line separated key: value blocks into records', () => {
    const text = 'Order: A-1\nAmount: 300\n\nOrder: A-2\nAmount: 450\n'
    const result = inferExtraction([
      plain(text),
    ], { minSamples: 2 })
    expect(result && applyExtractSpec(text, result.spec)).toEqual([
      { order: 'A-1', amount: 300 },
      { order: 'A-2', amount: 450 },
    ])
  })
})

describe('inferExtraction: nothing to extract', () => {
  const article = (title: string, body: string): string => `<html><body><article><h1>${title}</h1><p>${body}</p><p>${body} ${body}</p></article></body></html>`
  const words = 'Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris.'

  it('returns null for free-form prose in HTML and text', () => {
    expect(inferExtraction([
      html(article('One', words)),
      html(article('Two', [...words].reverse().join(''))),
    ], { minSamples: 2 })).toBeNull()
    expect(inferExtraction([
      plain('Thank you for visiting. We are open, as always, from nine to five.\nPlease come again soon, and bring a friend.'),
    ], { minSamples: 2 })).toBeNull()
  })

  it('returns null for JSON, mixed samples, no samples, and pages without a structure', () => {
    expect(inferExtraction([
      plain('{"a":1}', 'application/json'),
    ], { minSamples: 2 })).toBeNull()
    expect(inferExtraction([
      html(kitchen),
      plain('a,b\n1,2'),
    ], { minSamples: 2 })).toBeNull()
    expect(inferExtraction([], { minSamples: 2 })).toBeNull()
    expect(inferExtraction([
      html(nextDataPage('demo-key-1', 'u_1')),
    ], { minSamples: 2 })).toBeNull()
  })
})
