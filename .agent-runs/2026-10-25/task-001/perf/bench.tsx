/**
 * 渲染性能基准（Max-2 本地自检用，临时目录，不进仓库）。
 * 用 react-dom/server 对 256 行设备表做 20 轮「全新快照」渲染，
 * 这是最坏情况：SSR 不复用 memo，每轮都是完整协调 + 序列化。
 */
import { renderToString } from 'react-dom/server'
import { DevicesView } from '@app/views/DevicesView'

const N = 256

function makeDevices(seed: number) {
  const out = []
  for (let i = 0; i < N; i += 1) {
    const sampled = i % 3 === 0
    const degraded = i % 17 === 0
    out.push({
      id: `dev-${i}`,
      ip: `192.168.${(i >> 8) & 255}.${i & 255}`,
      mac: i % 5 === 0 ? null : `9c:93:4e:00:00:${(i & 255).toString(16).padStart(2, '0')}`,
      hostname: i % 4 === 0 ? null : `PC-${1000 + i}`,
      vendor: i % 6 === 0 ? null : 'Intel Corporate',
      osHint: i % 8 === 0 ? 'Windows' : null,
      kind: i % 7 === 0 ? 'server' : 'workstation',
      state: degraded ? 'degraded' : i % 23 === 0 ? 'offline' : 'online',
      firstSeen: 1761300000000,
      lastSeen: 1761300000000 + seed * 5000,
      openPorts: i % 10 === 0 ? [445, 3389] : [],
      quality: sampled
        ? {
            latencyMs: 3 + (i % 40) + seed * 0.01,
            jitterMs: 0.5,
            packetLossPct: degraded ? 23 : 0,
            score: degraded ? 42 : 92,
            grade: degraded ? 'poor' : 'good',
            samples: 12,
          }
        : { latencyMs: null, jitterMs: null, packetLossPct: 0, score: 0, grade: 'unknown', samples: 0 },
      bandwidth: {
        rxBps: i % 4 === 0 ? 1200 + seed : 0,
        txBps: i % 4 === 0 ? 800 + seed : 0,
        share: 0,
        connections: 0,
        attributable: i % 4 === 0,
        estimated: true,
      },
      rttHistory: [],
      isGateway: i === 0,
      isSelf: i === 1,
      displayName: null,
    })
  }
  return out
}

const noop = () => {}

// 预热（JIT + 首次模块求值）
for (let i = 0; i < 3; i += 1) {
  renderToString(
    <DevicesView
      devices={makeDevices(i)}
      selectedId={null}
      onOpenDetail={noop}
      scanning={false}
      totalDevices={N}
    />
  )
}

const samples: number[] = []
let htmlBytes = 0
for (let round = 0; round < 20; round += 1) {
  const devices = makeDevices(round)
  const t0 = performance.now()
  const html = renderToString(
    <DevicesView
      devices={devices}
      selectedId={null}
      onOpenDetail={noop}
      scanning={false}
      totalDevices={N}
    />
  )
  const dt = performance.now() - t0
  samples.push(dt)
  htmlBytes = html.length
}

samples.sort((a, b) => a - b)
const sum = samples.reduce((a, b) => a + b, 0)
console.log(
  JSON.stringify(
    {
      rows: N,
      rounds: 20,
      avgMs: +(sum / samples.length).toFixed(2),
      p50Ms: +samples[10].toFixed(2),
      maxMs: +samples[samples.length - 1].toFixed(2),
      minMs: +samples[0].toFixed(2),
      htmlKB: Math.round(htmlBytes / 1024),
      samples: samples.map((x) => +x.toFixed(2)),
    },
    null,
    2
  )
)
