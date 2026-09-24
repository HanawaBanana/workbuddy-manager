'use client';

import {useCallback, useEffect, useRef, useState} from 'react';
import {Eye, Gift, Loader2, Play, Sparkles, Square, TriangleAlert} from 'lucide-react';
import {Button} from '@/components/ui/button';
import {Badge} from '@/components/ui/badge';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/animate-ui/radix/dialog';
import {accountApi, errText} from '@/lib/api';
import {useI18n} from '@/lib/i18n/provider';
import {RichText} from '@/lib/i18n/rich-text';
import {notify} from '@/lib/toast';
import {translateRunLine} from '@/lib/i18n/taskrun';
import {TaskRunResult} from '@/components/common/tasks/TaskRunResult';
import type {Account, TaskRunStatus} from '@/lib/types';

/**
 * 单账号「活动任务」弹窗（账号页）。
 *
 * 与「任务」页的一键执行是**同一条执行路径**（都走后端 `/api/task-run`，最终跑
 * 上游 `scripts/task_runner.py`），只有 target 不同：那边是 `ALL`（全部账号），
 * 这里是**一个 uid**。所以模式的风险分级、二次确认、输出回显都照搬那边的口径：
 *
 *   · 预览   只查询，不发任何写请求（随时可点）
 *   · 领奖   只把已完成任务的奖励领回来，幂等（不伪造行为）
 *   · 做任务 点亮 + 领奖 —— **会伪造活跃上报**（造画布、连发对话、批量用专家），
 *            所以必须二次确认，且默认不选中。
 *
 * 布局（v2，替代初版的三个小按钮 + 一坨日志）：
 *   · 顶部账号身份卡（头像字 + 昵称 + uid）；
 *   · 三张**模式卡**代替并排小按钮 —— 三种模式的风险差异靠卡片上的风险标签
 *     直接可见（只读 / 幂等 / 会写上游），不再依赖悬停提示；
 *   · 结果用结构化任务卡（TaskRunResult）代替整段日志；原始日志折叠保留。
 *
 * 后端同一时刻只允许一个任务（taskrun 是进程内单例），所以这里必须能回答
 * 「现在跑的是本账号还是别人（或全量）」——否则用户会以为自己的点击没生效。
 */

const MODES = [
  {mode: 'preview', icon: Eye, label: 'tasks.runPreview', risk: 'tasks.riskReadonly'},
  {mode: 'claim', icon: Gift, label: 'tasks.runClaim', risk: 'tasks.riskIdempotent'},
  {mode: 'full', icon: Play, label: 'tasks.runFull', risk: 'tasks.riskWrites'},
] as const;

type Mode = (typeof MODES)[number]['mode'];

export function AccountTaskDialog({
  account,
  open,
  onOpenChange,
  onFinished,
}: {
  /** null = 未选中任何账号（弹窗关闭态） */
  account: Account | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 一次任务跑完时通知外部（积分/状态可能变了，账号列表要重拉） */
  onFinished?: () => void;
}) {
  const {t, tp} = useI18n();
  const [status, setStatus] = useState<TaskRunStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmFull, setConfirmFull] = useState(false);
  /** 选中的模式：默认预览（最安全的一档作为默认值，而不是让用户从按钮堆里挑） */
  const [mode, setMode] = useState<Mode>('preview');
  // 轮询定时器：跑的时候高频，闲着的时候低频（与 TaskRunnerPanel 同一策略）
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** 上一次是否在跑 —— 用来识别「刚刚跑完」这一刻，通知外部刷新一次 */
  const wasRunning = useRef(false);

  const load = useCallback(async () => {
    try {
      const s = await accountApi.taskRunStatus();
      setStatus(s);
      return s;
    } catch {
      return null; // 拉状态失败不打扰用户（弹窗里的按钮会自然处于不可点状态）
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    let alive = true;
    wasRunning.current = false;
    setConfirmFull(false);
    const tick = async () => {
      const s = await load();
      if (!alive) return;
      const nowRunning = s?.running === true;
      // 由「跑着」变成「不跑」：跑完了。积分可能变了，让外层重拉一次账号列表。
      if (wasRunning.current && !nowRunning) onFinished?.();
      wasRunning.current = nowRunning;
      timer.current = setTimeout(tick, nowRunning ? 2000 : 15000);
    };
    tick();
    return () => {
      alive = false;
      if (timer.current) clearTimeout(timer.current);
    };
  }, [open, load, onFinished]);

  async function run(m: Mode, confirm = false) {
    if (!account) return;
    setBusy(true);
    try {
      // target 传完整 uid：上游脚本按「uid 前缀」匹配 auths 文件，完整 uid 必然
      // 唯一命中该账号（传前 8 位在极端情况下才需要担心碰撞）。
      await accountApi.taskRunStart(m, account.uid, confirm);
      notify.ok(t('tasks.runStarted'), t(`tasks.runMode_${m}`));
      await load();
    } catch (e) {
      notify.err(errText(e));
    } finally {
      setBusy(false);
    }
  }

  async function stop() {
    setBusy(true);
    try {
      const r = await accountApi.taskRunStop();
      // 后端只回两种固定文案（已停止 / 当前没有正在执行的任务），走短语表
      (r.ok ? notify.ok : notify.info)(tp(r.message));
      await load();
    } catch (e) {
      notify.err(errText(e));
    } finally {
      setBusy(false);
    }
  }

  const uid = account?.uid ?? '';
  const running = status?.running === true;
  /** 正在跑的**就是本账号**（全局单例，所以必须逐字比 target） */
  const runningThis = running && status?.target === uid;
  /** 正在跑，但跑的是别的账号或全部账号 */
  const runningOther = running && !runningThis;
  const unavailable = status !== null && !status.available;
  const otherLabel =
    (status?.target || '') === 'ALL'
      ? t('accounts.taskRunAllAccounts')
      : (status?.target || '').slice(0, 8);
  const nick = account?.nickname || t('accounts.unnamed');

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-[680px]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Sparkles className="size-4 text-muted-foreground" />
            {t('accounts.taskRunTitle')}
            {runningThis && (
              <Badge variant="secondary" className="rounded-full text-[10px]">
                <Loader2 className="mr-1 size-3 animate-spin" />
                {t('tasks.runRunning', {mode: t(`tasks.runMode_${status?.mode}`)})}
              </Badge>
            )}
          </DialogTitle>
          <DialogDescription className="pt-1 text-[13px]">
            {t('accounts.taskRunFor', {name: account?.nickname || account?.uid || ''})}
          </DialogDescription>
        </DialogHeader>

        {/* 账号身份卡：头像字 + 昵称 + uid。昵称会重复（同名号更常见），uid 才是唯一标识 */}
        <div className="flex items-center gap-3 rounded-xl bg-muted px-3.5 py-2.5">
          <div className="flex size-9 shrink-0 items-center justify-center rounded-full bg-primary/10 text-sm font-medium text-primary">
            {nick.slice(0, 1)}
          </div>
          <div className="min-w-0 flex-1">
            <div className="truncate text-[13px] font-medium text-foreground">{nick}</div>
            <div className="truncate font-mono text-[10px] text-muted-foreground">{uid}</div>
          </div>
          {account?.realm === 'global' && (
            <Badge variant="secondary" className="shrink-0 rounded-full text-[10px]">
              {t('realm.global')}
            </Badge>
          )}
        </div>

        {confirmFull ? (
          /* 做任务前的二次确认：把「会发生什么」写清楚，再让人点。
             与 TaskRunnerPanel 用同一套文案（tasks.runFullConfirm*）。 */
          <div className="space-y-3">
            <div className="flex items-start gap-2 rounded-xl bg-amber-500/10 px-3 py-2">
              <TriangleAlert className="mt-0.5 size-3.5 shrink-0 text-amber-500" />
              <span className="text-[13px] font-medium">{t('tasks.runFullConfirmTitle')}</span>
            </div>
            <p className="text-[13px] leading-relaxed text-muted-foreground">
              {/* 译文里用 ** 标重点（项目约定），由 RichText 渲染成 <b> */}
              <RichText text={t('tasks.runFullConfirmBody')} />
            </p>
            <div className="flex justify-end gap-2">
              <Button variant="ghost" size="sm" className="rounded-full"
                      onClick={() => setConfirmFull(false)}>
                {t('common.cancel')}
              </Button>
              <Button size="sm" className="rounded-full" disabled={busy}
                      onClick={async () => {
                        setConfirmFull(false);
                        await run('full', true);
                      }}>
                {t('tasks.runFullConfirmOk')}
              </Button>
            </div>
          </div>
        ) : (
          <>
            <p className="text-[11px] leading-relaxed text-muted-foreground">
              {t('accounts.taskRunDesc')}
            </p>

            {/* 跑的是别的任务：说清「谁在跑」，否则用户会以为自己的点击没生效 */}
            {runningOther && (
              <div className="flex items-start gap-2 rounded-xl bg-amber-500/10 px-3 py-2">
                <TriangleAlert className="mt-0.5 size-3.5 shrink-0 text-amber-500" />
                <span className="text-[11px] leading-relaxed text-muted-foreground">
                  {t('accounts.taskRunBusyOther', {target: otherLabel})}
                </span>
              </div>
            )}

            {/* 脚本不可用时说清原因与做法（而不是给一堆点了没反应的按钮） */}
            {unavailable && (
              <div className="flex items-start gap-2 rounded-xl bg-muted px-3 py-2">
                <TriangleAlert className="mt-0.5 size-3.5 shrink-0 text-amber-500" />
                {/* whitespace-pre-line：这段说明是分条的（两种部署形态各一条修法） */}
                <span className="text-[11px] leading-relaxed whitespace-pre-line text-muted-foreground">
                  {status?.unavailable_reason}
                </span>
              </div>
            )}

            {/* 模式卡：三种模式的风险差异一眼可见，不再依赖悬停提示。
                选中态用 ring 标出；running/unavailable 时整组禁用。 */}
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
              {MODES.map(({mode: m, icon: Icon, label, risk}) => {
                const selected = mode === m;
                const risky = m === 'full';
                return (
                  <button
                    key={m}
                    type="button"
                    disabled={busy || running || !!unavailable}
                    onClick={() => setMode(m)}
                    className={`flex items-start gap-2.5 rounded-xl border px-3 py-2.5 text-left transition-colors disabled:opacity-50 ${
                      selected
                        ? `border-transparent ring-1 ${risky ? 'ring-amber-500/60 bg-amber-500/5' : 'ring-primary/60 bg-primary/5'}`
                        : 'border-border/60 hover:bg-muted/60'
                    }`}
                  >
                    <Icon className={`mt-0.5 size-4 shrink-0 ${
                      risky ? 'text-amber-600 dark:text-amber-400' : 'text-muted-foreground'
                    }`} />
                    <span className="min-w-0">
                      <span className="block text-xs font-medium text-foreground">
                        {t(label)}
                      </span>
                      <span className={`mt-0.5 block text-[10px] ${
                        risky ? 'text-amber-600/90 dark:text-amber-400/90' : 'text-muted-foreground'
                      }`}>
                        {t(risk)}
                      </span>
                    </span>
                  </button>
                );
              })}
            </div>

            {/* 主操作行：一个明确的 CTA 代替三个并排按钮 */}
            <div className="flex items-center justify-end gap-2">
              {runningThis && (
                <Button variant="ghost" size="sm"
                        className="rounded-full text-red-500"
                        disabled={busy} onClick={stop}>
                  <Square className="mr-1.5 size-3.5" />
                  {t('tasks.runStop')}
                </Button>
              )}
              <Button size="sm"
                      className={`rounded-full ${mode === 'full' ? 'bg-amber-600 hover:bg-amber-600/90' : ''}`}
                      disabled={busy || running || !!unavailable}
                      onClick={() => (mode === 'full' ? setConfirmFull(true) : run(mode))}>
                {t('tasks.runStart')} · {t(`tasks.runMode_${mode}`)}
              </Button>
            </div>

            {/* 结果：结构化任务卡（有可解析的任务时）+ 折叠的原始日志 */}
            {status && status.lines.length > 0 && (
              <div className="space-y-2">
                <TaskRunResult lines={status.lines} running={running} />
                <details className="rounded-xl bg-muted/60 px-3 py-2 text-[11px] text-muted-foreground">
                  <summary className="cursor-pointer select-none">{t('tasks.showRawLog')}</summary>
                  <pre className="mt-1.5 max-h-[220px] overflow-auto whitespace-pre-wrap break-all font-mono text-[10px] leading-4">
                    {/* 回显的是上游脚本的原始 stdout（写死中文），译文只在展示层
                        按模板逐行替换 —— 详见 lib/i18n/taskrun.ts。 */}
                    {status.lines.map((l) => translateRunLine(l)).join('\n')}
                  </pre>
                </details>
              </div>
            )}
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
