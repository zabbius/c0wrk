// Unit tests for api/research.ts — boundary guards and node-shape sanitizing
// on the graph/status RPC paths ([47]: per-entry fail-closed).

import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockApp: Record<string, (...args: unknown[]) => Promise<unknown>> = {}

vi.mock('@/api/runtime', () => ({
  getApp: () => mockApp,
}))
vi.mock('@/lib/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn() },
}))

import { getResearchGraph, getResearchStatus } from '@/api/research'

const validNode = { id: 'H-001', title: 'Root cause', status: 'open', parents: [] }

describe('getResearchGraph boundary validation', () => {
  beforeEach(() => {
    delete mockApp.GetResearchGraph
  })

  it('drops malformed node entries instead of crashing the render path', async () => {
    mockApp.GetResearchGraph = vi.fn(() =>
      Promise.resolve({
        project_id: 'R-001',
        has_report: false,
        graph: {
          nodes: [
            validNode,
            { id: 'H-002' }, // missing title/status → dropped
            { id: 7, title: 'bad id', status: 'open' }, // non-string id → dropped
            { id: 'H-003', title: 'ok', status: 'open', parents: 'not-an-array' }, // malformed parents → dropped
          ],
          edges: [],
        },
        metrics: {},
        log: [],
      }),
    )

    const res = await getResearchGraph('R-001')

    expect(res.graph.nodes).toEqual([validNode])
  })

  it('drops nodes with malformed long-form fields but keeps valid ones', async () => {
    mockApp.GetResearchGraph = vi.fn(() =>
      Promise.resolve({
        project_id: 'R-001',
        has_report: false,
        graph: {
          nodes: [
            {
              ...validNode,
              statement: 'Bundles can be parsed.',
              verification_criterion: 'Recover 95%.',
              experiment_notes: 'Run 1 passed.',
              decision: 'continue',
              timebox: '5 days',
              result: 'Recovered 97%.',
            },
            { ...validNode, id: 'H-004', statement: 42 }, // non-string statement → dropped
            { ...validNode, id: 'H-005', decision: ['continue'] }, // non-string decision → dropped
            { ...validNode, id: 'H-006', experiment_notes: null }, // null long-form is fine (absent)
          ],
          edges: [],
        },
        metrics: {},
        log: [],
      }),
    )

    const res = await getResearchGraph('R-001')

    expect(res.graph.nodes.map((n) => n.id)).toEqual(['H-001', 'H-006'])
    expect(res.graph.nodes[0]).toMatchObject({
      statement: 'Bundles can be parsed.',
      verification_criterion: 'Recover 95%.',
      experiment_notes: 'Run 1 passed.',
      decision: 'continue',
    })
  })

  it('normalizes backend null slices to empty arrays', async () => {
    mockApp.GetResearchGraph = vi.fn(() =>
      Promise.resolve({
        project_id: 'R-001',
        has_report: false,
        graph: { nodes: null, edges: null },
        metrics: {},
        log: null,
      }),
    )

    const res = await getResearchGraph('R-001')

    expect(res.graph.nodes).toEqual([])
    expect(res.graph.edges).toEqual([])
    expect(res.log).toEqual([])
  })

  it('rejects a payload whose outer shape is invalid', async () => {
    mockApp.GetResearchGraph = vi.fn(() => Promise.resolve({ nope: true }))

    await expect(getResearchGraph('R-001')).rejects.toThrow(/Invalid research graph/)
  })
})

describe('getResearchStatus boundary validation', () => {
  beforeEach(() => {
    delete mockApp.GetResearchStatus
  })

  it('drops malformed node entries in every project graph', async () => {
    mockApp.GetResearchStatus = vi.fn(() =>
      Promise.resolve({
        enabled: true,
        project_id: 'R-001',
        research_root: '/ws/.research',
        root: {
          path: '/ws/.research',
          projects: [
            {
              id: 'R-001',
              graph: { nodes: [validNode, { bogus: true }], edges: [] },
              log: null,
            },
          ],
        },
      }),
    )

    const res = await getResearchStatus('R-001')

    expect(res.root?.projects[0]!.graph.nodes).toEqual([validNode])
    expect(res.root?.projects[0]!.log).toEqual([])
  })
})
