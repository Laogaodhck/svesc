/**
 * 告警引擎。
 *
 * 规则（plan.md §5.1 修订版，**禁止**为 ICMP 不可达告警）：
 *  - DEVICE_OFFLINE   critical：state 变为 offline（ARP 连续 3 轮缺席且 ping 无响应，唯一判离线路径）
 *  - DEVICE_NEW       info    ：新 MAC 首次出现（首轮只做种，不刷屏）；产生后保持 active，
 *                              直到用户 ack 或 TTL `NEW_DEVICE_TTL_MS`（10 分钟）到期才 resolved
 *  - NET_QUALITY      warning ：grade==='poor' 连续 2 轮
 *  - SUPPLY_LOW       warning ：耗材 ≤10%，**仅当 levelPct !== null**
 *  - SUPPLY_CRITICAL  critical：耗材 ≤5%，同上
 *  - PRINTER_ERROR    critical：state === 'error'
 *  - PRINTER_OFFLINE  critical：网络打印机 TCP 9100/631/515 不可达而 spooler 仍报 Normal（`.213` 场景）
 *  - IP_CONFLICT      critical：同一 IP 在 ARP 表解析出多个不同 MAC（task-017 侦测增强）
 *
 * 去重键 = `${code}:${targetId}`；同因不重复刷屏；条件消失自动 resolved；历史上限 500 条。
 * 例外：DEVICE_NEW 是**事件型**告警，"设备还在"并不等于"告警该消失"，只能由 ack 或 TTL 收尾。
 *
 * 抑制窗口（task-017）：转变型告警清除后 `ALARM_THRESHOLDS.suppressWindowMs`（10 分钟）内
 * 同因再次触发 → 合并回原记录（occurrences+1、lastRaisedAt 刷新、trace 记 re-raised），
 * 不新建、不重复推送（onAlarm 不触发），抑制离线闪断/耗材临界反复穿越造成的误报刷屏。
 * 已确认过的告警重开保留 ack 状态（用户已表态过）；窗口外照常新建，历史事实不吞。
 */
import type { Alarm, AlarmSeverity, AlarmTraceEntry, Device, Printer } from '../../shared/types';
import {
  ALARM_THRESHOLDS,
  ALARM_TRACE_MAX,
  NEW_DEVICE_TTL_MS,
  QUALITY_MIN_SAMPLES,
  WINDOW,
} from '../../shared/constants';

export interface AlarmInput {
  devices: Device[];
  printers: Printer[];
  /** printerId → 网络可达性（null/缺失 = 无法判定，不产生 PRINTER_OFFLINE） */
  printerReachable: Map<string, boolean | null>;
  /**
   * 本轮 ARP 解析出的同 IP 多 MAC 冲突（task-017）。
   * null/undefined = 本轮没有有效 ARP 读取（不新增也不清理——一次解析失败 ≠ 冲突消失）；
   * 数组（可为空）= 本轮 ARP 有效：出现的冲突产生告警，消失的冲突自动收尾。
   */
  arpConflicts?: { ip: string; macs: string[] }[] | null;
  /**
   * 本轮 printers 是否代表"已采集完毕的全量监控集"（scheduler 首次 refreshPrinters
   * 成功后恒 true）。启动初期的带宽 tick 会以空列表调 evaluate，此时绝不能把
   * 打印机活跃告警当"目标消失"批量收尾——那是把"还没数据"当成"没有设备"。
   */
  printersCollected?: boolean;
  now?: number;
}

export interface AlarmEvaluation {
  /** 全量（含已恢复），按 raisedAt 倒序 */
  alarms: Alarm[];
  /** 本轮新产生的告警（用于 lan:alarm 推送；抑制窗口内的合并重开**不算**，不重复打扰） */
  created: Alarm[];
  /** 本轮抑制窗口内合并重开的告警（快照会带上，但不再触发通知推送） */
  reopened: Alarm[];
  /** 本轮自动恢复的告警 id */
  resolved: string[];
}

export const ALARM_CODES = {
  DEVICE_OFFLINE: 'DEVICE_OFFLINE',
  DEVICE_NEW: 'DEVICE_NEW',
  NET_QUALITY: 'NET_QUALITY',
  SUPPLY_LOW: 'SUPPLY_LOW',
  SUPPLY_CRITICAL: 'SUPPLY_CRITICAL',
  PRINTER_ERROR: 'PRINTER_ERROR',
  PRINTER_OFFLINE: 'PRINTER_OFFLINE',
  IP_CONFLICT: 'IP_CONFLICT',
  /** 持续 Ping 监控目标宕机（task-025，由 WatchManager 变迁经 ingestExternal 注入） */
  WATCH_DOWN: 'WATCH_DOWN',
} as const;

export function dedupeKey(code: string, targetId: string): string {
  return `${code}:${targetId}`;
}

export class AlarmEngine {
  private alarms: Alarm[] = [];
  private active = new Map<string, Alarm>();
  /** 同因最近一条告警（含已清除）：抑制窗口重开合并的查找索引。 */
  private recentByKey = new Map<string, Alarm>();
  /**
   * 用户手动清除冷静期（task-021）：key → 清除时间。手动清除后
   * ALARM_THRESHOLDS.suppressWindowMs（10 分钟）内同因再触发**完全静默**
   * （不新建、不重开、不推送）——尊重"用户已处理"的表态；窗口过后条件仍满足
   * 才产生全新告警，不丢"问题还在要提醒"的诚实性。evaluate 入口清理过期条目防膨胀。
   */
  private manualClears = new Map<string, number>();
  private poorStreak = new Map<string, number>();
  private knownDeviceKeys = new Set<string>();
  private seeded = false;
  private seq = 0;

  /**
   * @param historyLimit 历史保留条数
   * @param baselineUntil 可选：该时间戳之前发现的设备只做种、不产生 DEVICE_NEW（默认 0 = 不静默）。
   *   默认路径靠"首轮只做种"即可避免启动刷屏，基线窗口只用于特殊场景。
   */
  constructor(
    private readonly historyLimit = WINDOW.alarmHistory,
    private readonly baselineUntil = 0,
  ) {}

  /** 从持久化状态恢复（只恢复未恢复的活跃告警与已知设备种）。 */
  hydrate(state: { alarms?: Alarm[]; knownDeviceKeys?: string[] }): void {
    if (state.alarms) {
      // 迁移：旧版本把未恢复的 DEVICE_NEW 在 hydrate 时直接置 resolvedAt=raisedAt，
      // 留下一批"同毫秒已恢复"的垃圾记录（UI 上永远显示"（已恢复）"）。这类记录无信息量，丢弃。
      this.alarms = state.alarms
        .filter(
          (alarm) =>
            !(
              alarm.code === ALARM_CODES.DEVICE_NEW &&
              alarm.resolvedAt !== null &&
              alarm.resolvedAt <= alarm.raisedAt
            ),
        )
        .slice(-this.historyLimit);
      const now = Date.now();
      for (const alarm of this.alarms) {
        // task-015 迁移：升级前落盘的告警没有 ackBy 字段 → 规整为 null（store 校验器之外的直喂路径兜底）
        alarm.ackBy = alarm.ackBy ?? null;
        // task-017 迁移：旧数据无 lastRaisedAt/occurrences/trace → 补形状；trace 为空时从既有时间戳重建流转账目
        alarm.lastRaisedAt = typeof alarm.lastRaisedAt === 'number' ? alarm.lastRaisedAt : alarm.raisedAt;
        alarm.occurrences = typeof alarm.occurrences === 'number' && alarm.occurrences >= 1 ? alarm.occurrences : 1;
        if (!Array.isArray(alarm.trace)) alarm.trace = [];
        if (alarm.trace.length === 0) {
          const trace: AlarmTraceEntry[] = [{ at: alarm.raisedAt, type: 'raised', by: null }];
          if (alarm.ackAt !== null) trace.push({ at: alarm.ackAt, type: 'acked', by: alarm.ackBy });
          if (alarm.resolvedAt !== null) trace.push({ at: alarm.resolvedAt, type: 'resolved', by: null });
          alarm.trace = trace;
        }
        // 抑制窗口索引：同因最近一条（列表按时间升序，后面的覆盖前面的）
        this.recentByKey.set(dedupeKey(alarm.code, alarm.targetId), alarm);
        if (alarm.code === ALARM_CODES.DEVICE_NEW && alarm.resolvedAt === null) {
          // 重启续命：未 ack 且未超 TTL 的新设备提示仍然有效，否则按到期时间收尾
          if (alarm.ackAt !== null || now >= alarm.raisedAt + NEW_DEVICE_TTL_MS) {
            alarm.resolvedAt = alarm.ackAt ?? alarm.raisedAt + NEW_DEVICE_TTL_MS;
            continue;
          }
        }
        if (alarm.resolvedAt === null) this.active.set(dedupeKey(alarm.code, alarm.targetId), alarm);
      }
    }
    if (state.knownDeviceKeys && state.knownDeviceKeys.length > 0) {
      this.knownDeviceKeys = new Set(state.knownDeviceKeys);
      this.seeded = true;
    }
  }

  snapshotState(): { alarms: Alarm[]; knownDeviceKeys: string[] } {
    return { alarms: this.alarms.slice(-this.historyLimit), knownDeviceKeys: Array.from(this.knownDeviceKeys) };
  }

  all(): Alarm[] {
    return this.alarms.slice().sort((a, b) => b.raisedAt - a.raisedAt);
  }

  activeAlarms(): Alarm[] {
    return Array.from(this.active.values()).sort((a, b) => b.raisedAt - a.raisedAt);
  }

  counts(): { critical: number; warning: number; info: number } {
    const out = { critical: 0, warning: 0, info: 0 };
    for (const alarm of this.active.values()) out[alarm.severity] += 1;
    return out;
  }

  /** 流转账目追加（有界：最新 ALARM_TRACE_MAX 条，超出裁最旧）。 */
  private pushTrace(alarm: Alarm, entry: AlarmTraceEntry): void {
    alarm.trace.push(entry);
    if (alarm.trace.length > ALARM_TRACE_MAX) {
      alarm.trace.splice(0, alarm.trace.length - ALARM_TRACE_MAX);
    }
  }

  ack(alarmId: string, at = Date.now(), ackBy: string | null = null): boolean {
    const alarm = this.alarms.find((a) => a.id === alarmId);
    if (!alarm || alarm.ackAt !== null) return false;
    alarm.ackAt = at;
    // 确认人随确认时间一起落账（task-015）；null = 旧数据或调用方未提供
    alarm.ackBy = ackBy;
    this.pushTrace(alarm, { at, type: 'acked', by: ackBy });
    // 事件型告警没有"条件消失"这一说：ack 即收尾（其余告警仍需等条件消失才 resolved）
    if (alarm.code === ALARM_CODES.DEVICE_NEW) {
      if (alarm.resolvedAt === null) alarm.resolvedAt = at;
      this.active.delete(dedupeKey(alarm.code, alarm.targetId));
    }
    return true;
  }

  /**
   * 用户手动清除（task-021 语义 A）：置 resolvedAt + trace 记 cleared-by-user（带操作人），
   * 记录保留在"已清除/全部"可追溯——不做删除/软删（破坏 trace 账目，且 stop 全量
   * REPLACE 兜底会让删除复活）。与条件恢复的自动 resolve 共用 cleared 终态（cleared 不可逆）。
   * recentByKey 保持原样（不摘除）：重开合并由 manualClears 冷静期在 raise 路径前置拦截。
   */
  clear(id: string, by: string): boolean {
    const alarm = this.alarms.find((a) => a.id === id);
    if (!alarm || alarm.resolvedAt !== null) return false;
    const at = Date.now();
    alarm.resolvedAt = at;
    this.pushTrace(alarm, { at, type: 'cleared-by-user', by });
    this.active.delete(dedupeKey(alarm.code, alarm.targetId));
    this.manualClears.set(dedupeKey(alarm.code, alarm.targetId), at);
    return true;
  }

  /** 批量手动清除：逐条调 clear，返回成功条数。 */
  clearMany(ids: readonly string[], by: string): number {
    let cleared = 0;
    for (const id of ids) if (this.clear(id, by)) cleared += 1;
    return cleared;
  }

  /** DEVICE_NEW 的 TTL 收尾：到期（或已 ack）才 resolved，绝不"下一轮同毫秒批量恢复"。 */
  private expireNewDevices(now: number, resolvedIds: string[]): void {
    for (const [key, alarm] of Array.from(this.active.entries())) {
      if (alarm.code !== ALARM_CODES.DEVICE_NEW) continue;
      const dueAt = alarm.ackAt ?? alarm.raisedAt + NEW_DEVICE_TTL_MS;
      if (now < dueAt) continue;
      alarm.resolvedAt = dueAt;
      this.active.delete(key);
      resolvedIds.push(alarm.id);
    }
  }

  evaluate(input: AlarmInput): AlarmEvaluation {
    const now = input.now ?? Date.now();
    const created: Alarm[] = [];
    const reopened: Alarm[] = [];
    const resolvedIds: string[] = [];

    // 冷静期台账防膨胀（task-021）：过窗条目已无意义，入口统一清理
    for (const [key, clearedAt] of this.manualClears) {
      if (now - clearedAt >= ALARM_THRESHOLDS.suppressWindowMs) this.manualClears.delete(key);
    }

    this.expireNewDevices(now, resolvedIds);

    const raise = (
      code: string,
      severity: AlarmSeverity,
      targetType: Alarm['targetType'],
      targetId: string,
      targetName: string,
      message: string,
      detail: string | null,
    ): void => {
      const key = dedupeKey(code, targetId);
      if (this.active.has(key)) return;
      // 用户清除冷静期（task-021）：手动清除后 suppressWindowMs 内同因再触发完全静默——
      // 不新建、不重开、不推送（用户刚清掉 1 秒后告警就"复活"是最差的体验）。必须在
      // 抑制窗口判定**之前**拦截：否则会走合并重开把刚清掉的记录拉回来。
      const manualClearedAt = this.manualClears.get(key);
      if (manualClearedAt !== undefined) {
        if (now - manualClearedAt < ALARM_THRESHOLDS.suppressWindowMs) return;
        this.manualClears.delete(key); // 已过窗：条目失效，走正常流程（产生全新告警）
      }
      // 抑制窗口（task-017）：同因告警清除后 10 分钟内再次触发 → 合并回原记录。
      // 事件型 DEVICE_NEW 不参与（ack/TTL 收尾后没有"抖动重开"的语义）。
      const last = this.recentByKey.get(key);
      if (
        last &&
        code !== ALARM_CODES.DEVICE_NEW &&
        last.resolvedAt !== null &&
        now - last.resolvedAt < ALARM_THRESHOLDS.suppressWindowMs
      ) {
        last.resolvedAt = null;
        last.occurrences += 1;
        last.lastRaisedAt = now;
        // 已确认过的重开保留 ack 状态（用户已表态过，窗口内抖动不再升级打扰）；未确认的自然仍是 pending
        this.pushTrace(last, { at: now, type: 're-raised', by: null });
        this.active.set(key, last);
        reopened.push(last);
        return;
      }
      this.seq += 1;
      const alarm: Alarm = {
        id: `alm-${now.toString(36)}-${this.seq.toString(36)}`,
        severity,
        code,
        targetType,
        targetId,
        targetName,
        message,
        detail,
        raisedAt: now,
        ackAt: null,
        ackBy: null,
        resolvedAt: null,
        lastRaisedAt: now,
        occurrences: 1,
        trace: [{ at: now, type: 'raised', by: null }],
      };
      this.alarms.push(alarm);
      this.active.set(key, alarm);
      this.recentByKey.set(key, alarm);
      created.push(alarm);
    };

    const resolve = (code: string, targetId: string): void => {
      const key = dedupeKey(code, targetId);
      const alarm = this.active.get(key);
      if (!alarm) return;
      alarm.resolvedAt = now;
      this.pushTrace(alarm, { at: now, type: 'resolved', by: null });
      this.active.delete(key);
      resolvedIds.push(alarm.id);
    };

    // —— 设备：离线 ——
    for (const device of input.devices) {
      if (device.isSelf) continue;
      if (device.state === 'offline') {
        raise(
          ALARM_CODES.DEVICE_OFFLINE,
          'critical',
          'device',
          device.id,
          device.displayName ?? device.hostname ?? device.ip,
          `设备离线：${device.displayName ?? device.hostname ?? device.ip}`,
          `IP ${device.ip} · MAC ${device.mac ?? '未知'} · ARP 连续 ${ALARM_THRESHOLDS.offlineArpMisses} 轮缺席且 ICMP 无响应`,
        );
      } else {
        resolve(ALARM_CODES.DEVICE_OFFLINE, device.id);
      }
    }

    // —— 设备：新出现 ——
    for (const device of input.devices) {
      const key = device.mac ?? `ip:${device.ip}`;
      if (this.knownDeviceKeys.has(key)) continue;
      this.knownDeviceKeys.add(key);
      // 首轮只做种：否则一次扫描就刷出 50 条 DEVICE_NEW 噪音；
      // 第二轮起出现的新 MAC 才是"运行期接入"，产生 1 条并保持 active 直到 ack / TTL
      if (this.seeded && !device.isSelf && now > this.baselineUntil) {
        raise(
          ALARM_CODES.DEVICE_NEW,
          'info',
          'device',
          device.id,
          device.displayName ?? device.hostname ?? device.ip,
          `新设备接入：${device.displayName ?? device.hostname ?? device.ip}`,
          `IP ${device.ip} · MAC ${device.mac ?? '未知'} · 厂商 ${device.vendor ?? '未知'}`,
        );
      }
    }
    // "首轮"指的是**首次拿到非空设备列表**的那一轮：启动初期的带宽 tick 可能在扫描完成前
    // 先调一次 evaluate（devices=[]），若那时就把 seeded 置 true，扫描结果会被误判成
    // "运行期新接入"而刷出 19 条 DEVICE_NEW——这正是修复前的缺陷。
    if (input.devices.length > 0) this.seeded = true;

    // —— 设备：IP 地址冲突（task-017 侦测增强，联动设备列表 ipConflict 徽标）——
    // arpConflicts 为 null = 本轮没有有效 ARP 读取：不新增也不清理（一次解析失败 ≠ 冲突消失）。
    if (input.arpConflicts) {
      const conflictIds = new Set<string>();
      for (const conflict of input.arpConflicts) {
        const id = deviceIdOf(conflict.ip);
        conflictIds.add(id);
        raise(
          ALARM_CODES.IP_CONFLICT,
          'critical',
          'device',
          id,
          conflict.ip,
          `IP 地址冲突：${conflict.ip}`,
          `同一 IP 解析出 ${conflict.macs.length} 个 MAC（${conflict.macs.join(' / ')}），疑似地址冲突或 ARP 欺骗`,
        );
      }
      // 本轮 ARP 有效但冲突消失 → 收尾（IP_CONFLICT 是转变型：条件恢复自动清除）
      for (const [key, alarm] of Array.from(this.active.entries())) {
        if (alarm.code !== ALARM_CODES.IP_CONFLICT || conflictIds.has(alarm.targetId)) continue;
        alarm.resolvedAt = now;
        this.pushTrace(alarm, { at: now, type: 'resolved', by: null });
        this.active.delete(key);
        resolvedIds.push(alarm.id);
      }
    }

    // —— 设备：网络质量（poor 连续 2 轮） ——
    for (const device of input.devices) {
      if (device.isSelf) continue;
      if (device.quality.grade === 'poor') {
        const streak = (this.poorStreak.get(device.id) ?? 0) + 1;
        this.poorStreak.set(device.id, streak);
        // 与 computeQuality/isDegraded 同一置信门：grade 在 samples<8 时本就是 unknown
        if (streak >= ALARM_THRESHOLDS.poorGradeRounds && device.quality.samples >= QUALITY_MIN_SAMPLES) {
          raise(
            ALARM_CODES.NET_QUALITY,
            'warning',
            'device',
            device.id,
            device.displayName ?? device.ip,
            `网络质量劣化：${device.displayName ?? device.ip}`,
            `延迟 ${device.quality.latencyMs ?? '-'} ms · 丢包 ${device.quality.packetLossPct.toFixed(1)}% · 抖动 ${device.quality.jitterMs ?? '-'} ms · 评分 ${device.quality.score}`,
          );
        }
      } else {
        this.poorStreak.set(device.id, 0);
        resolve(ALARM_CODES.NET_QUALITY, device.id);
      }
    }

    // —— 打印机：故障 / 离线 / 耗材 ——
    for (const printer of input.printers) {
      if (printer.state === 'error') {
        raise(
          ALARM_CODES.PRINTER_ERROR,
          'critical',
          'printer',
          printer.id,
          printer.name,
          `打印机故障：${printer.name}`,
          printer.stateDetail,
        );
      } else {
        resolve(ALARM_CODES.PRINTER_ERROR, printer.id);
      }

      const reachable = input.printerReachable.get(printer.id);
      if (printer.ip !== null && reachable === false) {
        raise(
          ALARM_CODES.PRINTER_OFFLINE,
          'critical',
          'printer',
          printer.id,
          printer.name,
          `打印机网络不可达：${printer.name}`,
          `IP ${printer.ip} · TCP 9100/631/515 均无响应 · spooler 状态 ${printer.stateDetail ?? '未知'}`,
        );
      } else if (reachable === true) {
        resolve(ALARM_CODES.PRINTER_OFFLINE, printer.id);
      }

      const measured = printer.consumables.filter((c) => c.levelPct !== null);
      const critical = measured.filter((c) => (c.levelPct as number) <= ALARM_THRESHOLDS.supplyCriticalPct);
      const low = measured.filter((c) => (c.levelPct as number) <= ALARM_THRESHOLDS.supplyLowPct);

      if (critical.length > 0) {
        raise(
          ALARM_CODES.SUPPLY_CRITICAL,
          'critical',
          'printer',
          printer.id,
          printer.name,
          `耗材即将耗尽：${printer.name}`,
          critical.map((c) => `${c.label} ${c.levelPct}%`).join(' · '),
        );
        resolve(ALARM_CODES.SUPPLY_LOW, printer.id);
      } else if (low.length > 0) {
        raise(
          ALARM_CODES.SUPPLY_LOW,
          'warning',
          'printer',
          printer.id,
          printer.name,
          `耗材偏低：${printer.name}`,
          low.map((c) => `${c.label} ${c.levelPct}%`).join(' · '),
        );
        resolve(ALARM_CODES.SUPPLY_CRITICAL, printer.id);
      } else {
        // levelPct 全为 null（设备不报告）不产生任何耗材告警，并清掉旧告警
        resolve(ALARM_CODES.SUPPLY_LOW, printer.id);
        resolve(ALARM_CODES.SUPPLY_CRITICAL, printer.id);
      }
    }

    // —— 打印机：从监控集中消失的条目（被忽略 / 手动条目被删 / 拔除）其活跃告警必须收尾 ——
    // 否则被忽略的故障打印机的 critical 告警会永久挂账：resolve 只发生在该打印机
    // 出现在本轮列表时，列表过滤后就没有任何路径能关掉它（且 hydrate 会跨重启续命）。
    // printersCollected 门控见 AlarmInput 注释：启动早期空列表 tick 不算数。
    if (input.printersCollected === true) {
      const present = new Set(input.printers.map((p) => p.id));
      for (const [key, alarm] of Array.from(this.active.entries())) {
        if (alarm.targetType !== 'printer' || present.has(alarm.targetId)) continue;
        alarm.resolvedAt = now;
        this.pushTrace(alarm, { at: now, type: 'resolved', by: null });
        this.active.delete(key);
        resolvedIds.push(alarm.id);
      }
    }

    this.trimHistory();

    return {
      alarms: this.all(),
      created,
      reopened,
      resolved: resolvedIds,
    };
  }

  private trimHistory(): void {
    if (this.alarms.length <= this.historyLimit) return;
    const activeIds = new Set(Array.from(this.active.values()).map((a) => a.id));
    const dropCount = this.alarms.length - this.historyLimit;
    let dropped = 0;
    const kept: Alarm[] = [];
    for (const alarm of this.alarms) {
      if (dropped < dropCount && !activeIds.has(alarm.id)) {
        dropped += 1;
        // 被裁掉的历史若还是抑制窗口索引的"最近一条"，同步摘除（防悬挂引用 + 误重开已丢弃记录）
        const key = dedupeKey(alarm.code, alarm.targetId);
        if (this.recentByKey.get(key) === alarm) this.recentByKey.delete(key);
        continue;
      }
      kept.push(alarm);
    }
    this.alarms = kept;
  }

  /**
   * 外部注入的告警（task-025，WatchManager 宕机变迁 → WATCH_DOWN）：
   * 复用 raise 的完整语义（active 去重 / 手动清除冷静期 / 抑制窗口合并重开），
   * 但不走 evaluate 入口。返回本轮新建或重开的告警（无变迁为 null，调用方据此决定是否推送）。
   */
  ingestExternal(
    code: string,
    severity: AlarmSeverity,
    targetType: Alarm['targetType'],
    targetId: string,
    targetName: string,
    message: string,
    detail: string | null,
    now = Date.now(),
  ): Alarm | null {
    const key = dedupeKey(code, targetId);
    if (this.active.has(key)) return null;
    // 手动清除冷静期（task-021 语义，与 evaluate.raise 同一处理）
    const manualClearedAt = this.manualClears.get(key);
    if (manualClearedAt !== undefined) {
      if (now - manualClearedAt < ALARM_THRESHOLDS.suppressWindowMs) return null;
      this.manualClears.delete(key);
    }
    // 抑制窗口合并重开（事件型 DEVICE_NEW 除外——ingestExternal 不接 DEVICE_NEW）
    const last = this.recentByKey.get(key);
    if (last && last.resolvedAt !== null && now - last.resolvedAt < ALARM_THRESHOLDS.suppressWindowMs) {
      last.resolvedAt = null;
      last.occurrences += 1;
      last.lastRaisedAt = now;
      this.pushTrace(last, { at: now, type: 're-raised', by: null });
      this.active.set(key, last);
      return last;
    }
    this.seq += 1;
    const alarm: Alarm = {
      id: `alm-${now.toString(36)}-${this.seq.toString(36)}`,
      severity,
      code,
      targetType,
      targetId,
      targetName,
      message,
      detail,
      raisedAt: now,
      ackAt: null,
      ackBy: null,
      resolvedAt: null,
      lastRaisedAt: now,
      occurrences: 1,
      trace: [{ at: now, type: 'raised', by: null }],
    };
    this.alarms.push(alarm);
    this.active.set(key, alarm);
    this.recentByKey.set(key, alarm);
    return alarm;
  }

  /**
   * 外部注入的条件恢复（task-025，WatchManager 恢复变迁 → WATCH_DOWN 收尾）。
   * 返回被恢复的告警（无活跃同因告警为 null），调用方据此触发 webhook resolved。
   */
  ingestResolve(code: string, targetId: string, now = Date.now()): Alarm | null {
    const key = dedupeKey(code, targetId);
    const alarm = this.active.get(key);
    if (!alarm) return null;
    alarm.resolvedAt = now;
    this.pushTrace(alarm, { at: now, type: 'resolved', by: null });
    this.active.delete(key);
    return alarm;
  }
}

/** 设备 id 生成规则（与 scheduler 保持一致，供跨模块引用）。 */
export function deviceIdOf(ip: string): string {
  return `dev-${ip}`;
}
