'use client';

import {useMemo, useState} from 'react';
import {ChevronDown, ChevronRight, Loader2} from 'lucide-react';
import {Badge} from '@/components/ui/badge';
import {useI18n} from '@/lib/i18n/provider';
import {translateRunLine} from '@/lib/i18n/taskrun';
import {
  parseTaskRunLines,
  type TaskRunAccountBlock,
  type TaskRunTask,
  type TaskRunTaskStatus,
} from '@/lib/taskrun-parse';

/**
 * 「成长任务」运行结果的结构化展示。
 *
 * 此前面板把脚本输出 <pre> 一贴了事：400 行日志里找「领到了多少、还差几个」，
 * 本质上是让用户替程序做 grep。这里参考 WorkBuddy 活动页的任务卡片重排：
 *
 *   · 顶部一行汇总（共几项 / 已入账几项 + 收益 / 待领 / 进行中 / 跳过 / 失败）；
 *   · 每个任务一行卡片：状态点 + 任务名 + 进度条 + 收益徽章，点击展开该任务的
 *     原始日志（需要对照上游时再用）；
 *   · 全量运行按账号分组（单账号运行没有分段头，也就不显示）。
 *
 * 原始日志不删除、默认折叠 —— 结构化视图是「看结果」，日志是「查细节」，两者
 * 服务不同的时刻，砍掉哪个都会被反噬。
 */

/** 状态点与徽章的配色（每档：点的底色 / 徽章文字色）。 */
const STATUS_STYLE: Record<TaskRunTaskStatus, {dot: string; text: string}> = {
  rewarded: {dot: 'bg-emerald-500', text: 'text-emerald-600 dark:text-emerald-400'},
  claimed: {dot: 'bg-emerald-500/60', text: 'text-emerald-600/90 dark:text-emerald-400/90'},
  done: {dot: 'bg-emerald-500', text: 'text-emerald-600 dark:text-emerald-400'},
  partial: {dot: 'bg-amber-500', text: 'text-amber-600 dark:text-amber-400'},
  nochange: {dot: 'bg-muted-foreground/40', text: 'text-muted-foreground'},
  claimable: {dot: 'bg-sky-500', text: 'text-sky-600 dark:text-sky-400'},
  lightable: {dot: 'bg-sky-500', text: 'text-sky-600 dark:text-sky-400'},
  registered: {dot: 'bg-indigo-400', text: 'text-indigo-500 dark:text-indigo-400'},
  active: {dot: 'bg-indigo-400', text: 'text-indigo-500 dark:text-indigo-400'},
  skipped: {dot: 'bg-muted-foreground/30', text: 'text-muted-foreground/80'},
  failed: {dot: 'bg-red-500', text: 'text-red-500'},
  unknown: {dot: 'bg-muted-foreground/30', text: 'text-muted-foreground/70'},
};

/** 汇总里出现的状态与顺序（0 项的不显示）。 */
const SUMMARY: {key: TaskRunTaskStatus; label: string; chip: string}[] = [
  {key: 'rewarded', label: 'tasks.sumRewarded', chip: 'text-emerald-600 dark:text-emerald-400'},
  {key: 'claimable', label: 'tasks.sumClaimable', chip: 'text-sky-600 dark:text-sky-400'},
  {key: 'lightable', label: 'tasks.sumClaimable', chip: 'text-sky-600 dark:text-sky-400'},
  {key: 'active', label: 'tasks.sumActive', chip: 'text-indigo-500 dark:text-indigo-400'},
  {key: 'skipped', label: 'tasks.sumSkipped', chip: 'text-muted-foreground'},
  {key: 'failed', label: 'tasks.sumFailed', chip: 'text-red-500'},
];

export function TaskRunResult({lines, running}: {lines: string[]; running: boolean}) {
  const {t} = useI18n();
  const parsed = useMemo(() => parseTaskRunLines(lines), [lines]);

  if (parsed.taskCount === 0 && parsed.accounts.length === 0) return null;

  const grouped = parsed.accounts.length > 1;

  return (
    <div className="space-y-2">
      {/* 汇总行 */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px]">
        <span className="font-medium text-foreground">
          {t('tasks.sumTotal', {n: parsed.taskCount})}
        </span>
        {SUMMARY.map(({key, label, chip}) =>
          parsed.counts[key] > 0 ? (
            <span key={key} className={chip}>
              {t(label, {n: parsed.counts[key]})}
            </span>
          ) : null,
        )}
        {parsed.totals.credit > 0 && (
          <span className="rounded-full bg-emerald-500/10 px-2 py-0.5 font-medium text-emerald-600 dark:text-emerald-400">
            {t('tasks.rewardGain', {credit: parsed.totals.credit})}
          </span>
        )}
        {running && (
          <span className="inline-flex items-center gap-1 text-muted-foreground">
            <Loader2 className="size-3 animate-spin" />
          </span>
        )}
      </div>

      {/* 任务卡片（多账号时分组；单账号不重复自己的 uid 头） */}
      <div className="max-h-[300px] space-y-1.5 overflow-y-auto pr-0.5">
        {parsed.accounts.map((acc) => (
          <AccountBlock key={acc.uid8} acc={acc} grouped={grouped} />
        ))}
      </div>

      {/* 未归类的行（WARN / 看护行）：默认收起，排查时展开 */}
      {parsed.notices.length > 0 && (
        <details className="rounded-xl bg-muted/60 px-3 py-2 text-[11px] text-muted-foreground">
          <summary className="cursor-pointer select-none">
            {t('tasks.noticesCount', {n: parsed.notices.length})}
          </summary>
          <ul className="mt-1.5 space-y-0.5 font-mono text-[10px] leading-4">
            {parsed.notices.map((l, i) => (
              <li key={i} className="break-all">
                {translateRunLine(l)}
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

function AccountBlock({acc, grouped}: {acc: TaskRunAccountBlock; grouped: boolean}) {
  const {t} = useI18n();
  if (acc.skippedRealm && acc.tasks.length === 0) {
    return grouped ? (
      <div className="flex items-center gap-2 rounded-xl bg-muted/60 px-3 py-2 text-[11px] text-muted-foreground">
        <span className="font-medium text-foreground/70">{acc.name || acc.uid8}</span>
        <span className="font-mono text-[10px]">{acc.uid8}</span>
        <span>{t('tasks.realmSkipped')}</span>
      </div>
    ) : null;
  }
  return (
    <div className="space-y-1.5">
      {grouped && (
        <div className="flex items-center gap-2 px-0.5 pt-1 text-[11px]">
          <span className="font-medium text-foreground/80">{acc.name || acc.uid8}</span>
          <span className="font-mono text-[10px] text-muted-foreground">{acc.uid8}</span>
          {acc.energy !== undefined && (
            <span className="text-[10px] text-muted-foreground">
              {t('tasks.energyNote', {n: acc.energy})}
            </span>
          )}
          {acc.errors.length > 0 && (
            <span className="text-[10px] text-red-500" title={acc.errors.join('\n')}>
              {t('tasks.accErrorCount', {n: acc.errors.length})}
            </span>
          )}
        </div>
      )}
      {acc.tasks.map((task) => (
        <TaskRow key={acc.uid8 + '/' + task.code} task={task} />
      ))}
    </div>
  );
}

function TaskRow({task}: {task: TaskRunTask}) {
  const {t} = useI18n();
  const [open, setOpen] = useState(false);
  const style = STATUS_STYLE[task.status];
  const prog =
    task.target && task.target > 0
      ? Math.min(task.cur ?? 0, task.target) / task.target
      : null;

  return (
    <div className="rounded-xl bg-muted/60">
      <button
        type="button"
        className="flex w-full items-center gap-2 px-3 py-2 text-left"
        onClick={() => setOpen((v) => !v)}
        title={task.note}
      >
        {open ? (
          <ChevronDown className="size-3 shrink-0 text-muted-foreground" />
        ) : (
          <ChevronRight className="size-3 shrink-0 text-muted-foreground" />
        )}
        <span className={`size-1.5 shrink-0 rounded-full ${style.dot}`} />
        <span className="min-w-0 flex-1 truncate text-xs text-foreground/90">
          {task.name}
          {task.cur !== null && task.target !== null && (
            <span className="ml-1.5 font-mono text-[10px] text-muted-foreground">
              {task.cur}/{task.target}
            </span>
          )}
        </span>
        {/* 进度条：有 target 才画，宽度按完成比 */}
        {prog !== null && (
          <span className="hidden h-1 w-16 shrink-0 overflow-hidden rounded-full bg-border sm:block">
            <span
              className="block h-full rounded-full bg-foreground/25"
              style={{width: `${Math.round(prog * 100)}%`}}
            />
          </span>
        )}
        {task.credit > 0 && (
          <span className="shrink-0 font-mono text-[10px] font-medium text-emerald-600 dark:text-emerald-400">
            +{task.credit}
          </span>
        )}
        <Badge
          variant="secondary"
          className={`shrink-0 rounded-full px-2 text-[10px] ${style.text}`}
        >
          {t(`tasks.st${task.status.charAt(0).toUpperCase()}${task.status.slice(1)}`)}
        </Badge>
      </button>
      {open && task.lines.length > 0 && (
        <pre className="whitespace-pre-wrap break-all border-t border-border/40 px-3 py-2 font-mono text-[10px] leading-4 text-muted-foreground">
          {task.lines.map((l) => translateRunLine(l)).join('\n')}
        </pre>
      )}
      {/* 不展开时，note（跳过原因 / 失败信息）用一行小字透出 —— 藏进 title 不够 */}
      {!open && task.note && (task.status === 'failed' || task.status === 'skipped' || task.status === 'partial') && (
        <div className="break-all px-3 pb-1.5 pl-7 text-[10px] leading-4 text-muted-foreground/80">
          {task.note}
        </div>
      )}
    </div>
  );
}
