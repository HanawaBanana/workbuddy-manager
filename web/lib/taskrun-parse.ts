/**
 * 把「成长任务一键执行」的输出行解析成**结构化的任务状态**。
 *
 * 面板此前只有 <pre> 日志回显：跑完 400 行，用户要在一串
 * `[task_runner] 4a9b0499 template_5: report 3/5 200 code=0 id=4` 里自己找
 * 「领到了多少、还差几个」。这份解析把同样的行变成「每个任务一行：名字、
 * 进度、状态、收益」，参考的是 WorkBuddy 活动页的任务卡片。
 *
 * 三点边界：
 *   · **解析在展示层**：上游 task_runner 是另一个仓库（volume 挂载），它的行格式
 *     就是事实来源；这里只读不改，规则与 lib/i18n/taskrun.ts 的翻译规则同源
 *     （那边负责「说什么」，这边负责「什么状态」）。上游新增行形态时最坏是
 *     该行进 notes/未知态，不会崩、不丢数据。
 *   · **状态取最后一次判定**：任务行按 accept → report → re-read → claim 的顺序
 *     到达，后到的判定（领到了/失败了）覆盖先到的（可领/进行中），与真实时序
 *     一致，不需要额外优先级表。
 *   · **任务码 → 名称**是展示层的尽力映射（写死常见码，认不出就显示码本身）；
 *     名称走短语表（tp），各语言可覆盖，中文源文即默认名。
 */
import {tp} from './i18n/index';

/** 单个任务的展示状态（与 i18n 的 tasks.st* 键一一对应）。 */
export type TaskRunTaskStatus =
  | 'rewarded' // 已入账（本轮领到，含收益）
  | 'claimed' // 已领取（此前领过 / 本轮确认已领）
  | 'done' // 已完成（点亮）
  | 'partial' // 部分点亮，未达 target
  | 'nochange' // 尝试点亮但状态未变化
  | 'claimable' // 可领取（预览时发现）
  | 'lightable' // 可点亮（预览时发现）
  | 'registered' // 已登记（accept 生效）
  | 'active' // 进行中（report 进度 / 未达 target）
  | 'skipped' // 跳过（不适用 / 不可伪造 / 非映射…）
  | 'failed' // 失败
  | 'unknown'; // 无法识别的行形态

export interface TaskRunTask {
  /** 上游任务码（如 create_canvas），唯一键是 uid8+code */
  code: string;
  /** 展示名：常见码映射成中文名（再走短语表），认不出就显示码 */
  name: string;
  status: TaskRunTaskStatus;
  cur: number | null;
  target: number | null;
  /** 本轮领到的收益累计（claim ok 行） */
  credit: number;
  energy: number;
  /** 跳过原因 / 失败信息 / 未识别行的原文片段 */
  note?: string;
  /** 该任务关联的原始行（展开详情用，调用方负责翻译） */
  lines: string[];
}

export interface TaskRunAccountBlock {
  uid8: string;
  /** 全量运行时 `== uid8 (昵称) ==` 头给的昵称；单账号运行没有 */
  name?: string;
  /** `query energy balance=N` 报告的能量余额 */
  energy?: number;
  /** 国际版账号在 CN 任务里整段跳过 */
  skippedRealm?: boolean;
  errors: string[];
  tasks: TaskRunTask[];
}

export interface TaskRunParsed {
  accounts: TaskRunAccountBlock[];
  /** 无法归到账号/任务的行（WARN、!! 看护行、未识别形态） */
  notices: string[];
  taskCount: number;
  totals: {credit: number; energy: number};
  counts: Record<TaskRunTaskStatus, number>;
}

/** 常见任务码 → 中文名（显示层尽力映射；认不出的码原样显示）。 */
const TASK_NAMES: Record<string, string> = {
  create_canvas: '画布任务',
  template_5: '模板任务',
  expert_5: '专家任务',
  Expert_team_use_3: '专家团队',
  expert_use: '使用专家',
  chat_3_times: '发起对话',
  desktop_chat_1_time: '桌面端对话',
  share_invite: '分享邀请',
  first_buddy: '领养 Buddy',
  black_cat: '夜猫任务',
  school_season: '校园日',
  minichat: '小程序对话',
};

function taskName(code: string): string {
  const zh = TASK_NAMES[code];
  // 短语表按「中文源文」查，各语言可覆盖；zh-CN 没有条目时原样返回中文
  return zh ? tp(zh) : code;
}

function emptyCounts(): Record<TaskRunTaskStatus, number> {
  return {
    rewarded: 0, claimed: 0, done: 0, partial: 0, nochange: 0,
    claimable: 0, lightable: 0, registered: 0, active: 0,
    skipped: 0, failed: 0, unknown: 0,
  };
}

/**
 * 解析全部输出行。行形态的事实来源是上游 scripts/task_runner.py 的 print 语句
 * 与本面板后端（services/taskrun.py）追加的看护行。
 */
export function parseTaskRunLines(raw: string[]): TaskRunParsed {
  const accounts = new Map<string, TaskRunAccountBlock>();
  const order: string[] = [];
  const notices: string[] = [];

  const blockFor = (uid8: string, name?: string): TaskRunAccountBlock => {
    let b = accounts.get(uid8);
    if (!b) {
      b = {uid8, errors: [], tasks: []};
      accounts.set(uid8, b);
      order.push(uid8);
    }
    if (name && !b.name) b.name = name;
    return b;
  };

  const taskFor = (b: TaskRunAccountBlock, code: string): TaskRunTask => {
    let task = b.tasks.find((x) => x.code === code);
    if (!task) {
      task = {
        code, name: taskName(code), status: 'unknown',
        cur: null, target: null, credit: 0, energy: 0, lines: [],
      };
      b.tasks.push(task);
    }
    return task;
  };

  for (const line0 of raw) {
    const line = line0.replace(/\s+$/, '');
    if (!line.trim()) continue;

    // ── 全量运行的账号分段头：== 4a9b0499 (小饼干) ==
    let m = /^== (\S+) \((.+)\) ==$/.exec(line);
    if (m) {
      blockFor(m[1], m[2]);
      continue;
    }

    // ── 后端看护行（!! …）与批量警告：运行级通知
    if (line.startsWith('!!') || line.startsWith('WARN:')) {
      notices.push(line);
      continue;
    }

    // ── 账号级：国际版整段跳过 / 任务清单拉取失败
    m = /^\[skip\] (\S+) global realm 不适用 CN 任务$/.exec(line);
    if (m) {
      blockFor(m[1]).skippedRealm = true;
      continue;
    }
    m = /^ERR: \[task_runner\] (\S+) query list_tasks 失败: (.*)$/.exec(line);
    if (m) {
      blockFor(m[1]).errors.push(m[2]);
      continue;
    }

    // ── 账号级：能量余额与 school 段说明（没有任务码，不能当任务行）
    m = /^\[task_runner\] (\S+) query energy balance=(\d+)$/.exec(line);
    if (m) {
      blockFor(m[1]).energy = Number(m[2]);
      continue;
    }
    m = /^\[task_runner\] (\S+) school\/tasks 拉取失败: (.*)$/.exec(line);
    if (m) {
      blockFor(m[1]).errors.push(`school/tasks: ${m[2]}`);
      continue;
    }
    if (/^\[task_runner\] (\S+) (school 活动非进行期（in_period=false），school 段跳过|school\/tasks in_period=\S+ tasks=\d+)$/.test(line)) {
      continue; // 说明性信息，界面不需要
    }

    // ── 数据抓取的 warn（回落内置表等）：运行级通知
    if (/^\s*\[warn\] /.test(line)) {
      notices.push(line.trim());
      continue;
    }

    // ── 任务行：[task_runner] <uid8> <code>: <rest>
    m = /^\[task_runner\] (\S+) (\S+): ([\s\S]*)$/.exec(line);
    if (m) {
      applyTaskLine(taskFor(blockFor(m[1]), m[2]), m[3], line);
      continue;
    }

    // 兜底：认不出的行进通知，不静默丢
    notices.push(line);
  }

  const counts = emptyCounts();
  const totals = {credit: 0, energy: 0};
  let taskCount = 0;
  for (const uid8 of order) {
    const b = accounts.get(uid8)!;
    for (const task of b.tasks) {
      counts[task.status] += 1;
      totals.credit += task.credit;
      totals.energy += task.energy;
      taskCount += 1;
    }
  }

  return {accounts: order.map((u) => accounts.get(u)!), notices, taskCount, totals, counts};
}

/** 对单个任务应用一行的判定。行按时间到达，后到的判定覆盖先到的。 */
function applyTaskLine(task: TaskRunTask, rest: string, rawLine: string): void {
  task.lines.push(rawLine);
  let m: RegExpMatchArray | null;

  // 复核进度（不改状态：claim 与否由后面的行说了算）
  if ((m = /^query re-read (\d+)\/(\d+) accept_status=(\S+)$/.exec(rest))) {
    task.cur = Number(m[1]);
    task.target = Number(m[2]);
    return;
  }

  // ── 领取结果（最关键的三态：入账 / 已领过 / 失败）
  if ((m = /^claim (\d+) ok\(credit=\+(\d+) energy=\+(\d+)\)$/.exec(rest))) {
    task.status = 'rewarded';
    task.credit += Number(m[2]);
    task.energy += Number(m[3]);
    return;
  }
  if (/^claim (\d+) already_claimed/.test(rest)) {
    task.status = 'claimed';
    return;
  }
  // school 域的领取变体：`claim {http} code={业务码}`（task_runner 在 `（点亮）`
  // 后打这行并计 stats["ok"]）。code=0 是成功，但响应不带收益数字 —— 升级为
  // 已入账（没有 +N 徽章，只有状态）；非 0 是业务失败。
  if ((m = /^claim (\d+) code=(\S+)$/.exec(rest))) {
    if (m[2] === '0') {
      task.status = 'rewarded';
    } else {
      task.status = 'failed';
      task.note = rest;
    }
    return;
  }
  if ((m = /^claim (\d+) (.*) -> ERR$/.exec(rest))) {
    task.status = 'failed';
    task.note = m[2];
    return;
  }
  if ((m = /^claim (\d+) (.*) -> 降级 web 域$/.exec(rest))) {
    task.status = 'failed';
    task.note = m[2];
    return;
  }
  if ((m = /^claim 失败: (.*)（可稍后补领）$/.exec(rest))) {
    task.status = 'failed';
    task.note = m[1];
    return;
  }

  // ── 点亮结果三分支 + 入账
  if ((m = /^(\S+)\/(\d+) -> claimed（本轮已入账）$/.exec(rest)) ||
      (m = /^(\S+) -> claimed（本轮已入账）$/.exec(rest))) {
    task.status = 'rewarded';
    return;
  }
  if ((m = /^(\S+) -> (\S+)\/(\S+)（点亮）$/.exec(rest))) {
    task.status = 'done';
    task.cur = Number(m[3]);
    task.target = Number(m[4]);
    return;
  }
  if ((m = /^(\S+) -> (\S+)\/(\S+)（部分点亮，未达 target）$/.exec(rest))) {
    task.status = 'partial';
    task.cur = Number(m[3]);
    task.target = Number(m[4]);
    return;
  }
  if ((m = /^(\S+) -> (\S+)\/(\S+)（未变化）$/.exec(rest))) {
    task.status = 'nochange';
    task.cur = Number(m[3]);
    task.target = Number(m[4]);
    return;
  }

  // ── 登记（accept）
  if ((m = /^accept 尝试(\d+) (\d+) status=(\S+) 回读=(\S+)( -> 生效)?$/.exec(rest))) {
    task.status = m[5] ? 'registered' : 'active';
    if (!m[5]) task.note = '未登记生效';
    return;
  }
  if ((m = /^accept (\d+) (.*)$/.exec(rest))) {
    // 例：`accept 200 error` —— HTTP 200 但业务 status 是 error
    task.status = /error/i.test(m[2]) ? 'failed' : 'registered';
    if (task.status === 'failed') task.note = m[2];
    return;
  }

  // ── 上报（report）
  if ((m = /^report (\d+)\/(\d+) (\d+) code=\S+/.exec(rest))) {
    task.status = 'active';
    task.cur = Number(m[1]);
    task.target = Number(m[2]);
    return;
  }
  if ((m = /^report 失败 #(\d+): (.*)$/.exec(rest))) {
    task.status = 'failed';
    task.note = m[2];
    return;
  }
  if ((m = /^report 未达 target（(\d+)\/(\d+)），WARN 待下次$/.exec(rest))) {
    task.status = 'active';
    task.cur = Number(m[1]);
    task.target = Number(m[2]);
    task.note = '未达 target，待下次';
    return;
  }
  if (/^report 无可用对象 id/.test(rest)) {
    task.status = 'skipped';
    task.note = '无可用对象 id';
    return;
  }
  if ((m = /^report 无需上报（(\d+)\/(\d+)）$/.exec(rest))) {
    task.cur = Number(m[1]);
    task.target = Number(m[2]);
    return;
  }
  if ((m = /^report (\S+) code=(\S+) 前置解锁$/.exec(rest))) {
    task.status = 'active';
    return;
  }

  // ── 查看类（viewed）
  if ((m = /^viewed 激活 (\S+)$/.exec(rest))) {
    task.status = 'registered';
    return;
  }
  if ((m = /^viewed 失败: (.*)$/.exec(rest))) {
    task.status = 'failed';
    task.note = m[1];
    return;
  }

  // ── 查询判定（带进度）
  if ((m = /^query (\S+)\((\d+)\/(\d+)\) -> (.*)$/.exec(rest))) {
    task.cur = Number(m[2]);
    task.target = Number(m[3]);
    applyQueryTail(task, m[4]);
    return;
  }
  // 查询判定（不带进度）
  if ((m = /^query (\S+) -> (.*)$/.exec(rest))) {
    applyQueryTail(task, m[2]);
    return;
  }
  if (/^query 任务不存在$/.test(rest)) {
    task.status = 'skipped';
    task.note = '任务不存在';
    return;
  }

  // ── 小程序（mp）口径
  if (/^mp 口径任务不存在，skip$/.test(rest)) {
    task.status = 'skipped';
    return;
  }
  if ((m = /^mp list_tasks 失败: (.*)$/.exec(rest))) {
    task.status = 'failed';
    task.note = m[1];
    return;
  }
  if ((m = /^mp 查询失败: (.*)$/.exec(rest))) {
    task.status = 'failed';
    task.note = m[1];
    return;
  }
  if (/^only_claim 跳过（未 completed）$/.test(rest)) {
    task.status = 'active';
    return;
  }

  // 未识别的形态：保留原文，不猜状态
  task.note = rest;
}

/** `query … -> <tail>` 的尾部判定。 */
function applyQueryTail(task: TaskRunTask, tail: string): void {
  if (/^已领，跳过/.test(tail) || /^已完成\/已领，跳过$/.test(tail)) {
    task.status = 'claimed';
    return;
  }
  if (/^可领\(claim\)/.test(tail)) {
    task.status = 'claimable';
    return;
  }
  if (/^可点亮/.test(tail)) {
    task.status = 'lightable';
    return;
  }
  if (/^不可伪造/.test(tail)) {
    task.status = 'skipped';
    task.note = tail.replace(/^不可伪造\((.*)\)，skip$/, '$1');
    return;
  }
  if (/非映射任务/.test(tail) || /任务不存在/.test(tail) || /^school 未映射/.test(tail)) {
    task.status = 'skipped';
    return;
  }
  if (/^未 completed，only_claim 跳过$/.test(tail) || /^only_claim dry-run 跳过$/.test(tail)) {
    task.status = 'active';
    return;
  }
  if (/夜猫窗口/.test(tail)) {
    task.status = 'skipped';
    task.note = tail.replace('，skip pending', '');
    return;
  }
  // 认不出的尾部：不覆盖已有状态，只记原文
  task.note = tail;
}
