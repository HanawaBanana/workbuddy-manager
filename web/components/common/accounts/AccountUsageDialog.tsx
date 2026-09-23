'use client';

import {Coins, Info, Sparkles} from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/animate-ui/radix/dialog';
import {useT} from '@/lib/i18n/provider';
import {RichText} from '@/lib/i18n/rich-text';
import {fmtDateTime, fmtNumber} from '@/lib/format';
import type {Account, CreditsMeta} from '@/lib/types';

/**
 * 账号「积分详情」弹窗：**这个号的分花在哪儿、还有多少要过期**。
 *
 * 为什么要做：账号页此前只给一个余额数字。用户看得见「少了」，看不见「少在哪」——
 * 而同一个模型在不同账号上的计价能差几十倍（线上实测 deepseek-v4-flash：
 * 0.0087 / 0.0490 / 0.0926 每千 token），这正是「为什么这个号掉分特别快」的答案。
 * 这份台账上游一直在记，只是没送到界面上。
 *
 * **口径必须写在界面上**：这里显示的是**单价**（每千 token 扣多少），不是消耗总量。
 * 「贵」与「用得多」是两件事，把单价读成消耗量会得出完全相反的结论（贵 ≠ 烧得多）。
 *
 * 三类信息各有来源，弹窗里分开列，不混在一起：
 *   · 余额      —— 实时查询值优先，其次上游快照（与账号列表同一口径）
 *   · 用分单价  —— 上游的实测成本台账（按账号 + 模型）
 *   · 套餐到期  —— 腾讯下发的分批额度（backend 换算成绝对时刻）
 */
export function AccountUsageDialog({
  account,
  open,
  onOpenChange,
  credits,
  meta,
}: {
  /** null = 未选中任何账号（弹窗关闭态） */
  account: Account | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 刚查到的实时余额；undefined = 只有上游快照 */
  credits?: number | null;
  /** 实时值的元信息（含各套餐到期明细） */
  meta?: CreditsMeta;
}) {
  const t = useT();

  const uid = account?.uid ?? '';
  const models = account?.model_costs ?? [];
  const expiries = meta?.expiries ?? [];
  // 与账号列表同一口径：优先实时值，其次上游 /status 的快照
  const live = credits === undefined ? undefined : credits;
  const balance = live ?? account?.credits ?? null;
  const fromSnapshot = live === undefined;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* 高度必须受控 + 内容区自己滚动：套餐到期是**逐笔**列出的，几十个账号的
          分批额度叠起来能到 20 条以上，不定高就会把弹窗撑出屏幕（实测：标题被顶到
          视口外、底部的条目够不到，而弹窗本身不会滚）。标题留在外面固定，
          滚动只发生在内容区。 */}
      <DialogContent className="flex max-h-[85dvh] max-w-[520px] flex-col">
        <DialogHeader className="shrink-0">
          <DialogTitle className="flex items-center gap-2">
            <Coins className="size-4 text-muted-foreground" />
            {t('accounts.usageTitle')}
          </DialogTitle>
          <DialogDescription className="pt-1 text-[13px]">
            {account?.nickname || account?.uid || ''}
          </DialogDescription>
        </DialogHeader>

        <div className="scroll-slim min-h-0 flex-1 space-y-4 overflow-y-auto pr-0.5">
          {/* 身份：昵称会重复，uid 才是唯一标识 */}
          <div className="truncate font-mono text-[11px] text-muted-foreground">{uid}</div>

          {/* 余额：与账号列表同口径，并标出来源（实时 / 上游快照） */}
          <div className="flex items-center justify-between rounded-xl bg-muted px-3 py-2">
            <span className="text-[11px] text-muted-foreground">{t('accounts.usageBalance')}</span>
            <span className="flex items-center gap-2">
              <span className="text-sm font-semibold tabular-nums">
                {balance === null ? '—' : fmtNumber(balance)}
              </span>
              {balance !== null && (
                <span
                  className={
                    'rounded-full px-1.5 py-0.5 text-[10px] leading-3 ' +
                    (fromSnapshot
                      ? 'bg-muted-foreground/15 text-muted-foreground'
                      : 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400')
                  }
                  title={fromSnapshot ? t('accounts.snapshotTitle') : t('accounts.liveTitle')}
                >
                  {fromSnapshot ? t('accounts.snapshot') : t('accounts.live')}
                </span>
              )}
            </span>
          </div>

          {/* 用分单价台账 */}
          <section className="space-y-1.5">
            <div className="flex items-center gap-1.5">
              <Sparkles className="size-3.5 text-muted-foreground" />
              <span className="text-[12px] font-medium">{t('accounts.usageModelsTitle')}</span>
            </div>
            <p className="text-[11px] leading-relaxed text-muted-foreground">
              {t('accounts.usageModelsDesc')}
            </p>
            {models.length ? (
              <div className="overflow-hidden rounded-xl border border-border/50">
                <table className="w-full text-[11px]">
                  <thead className="bg-muted/60 text-muted-foreground">
                    <tr>
                      <th className="px-2.5 py-1.5 text-left font-normal">{t('accounts.usageColModel')}</th>
                      <th className="px-2.5 py-1.5 text-right font-normal">{t('accounts.usageColCost')}</th>
                      <th className="px-2.5 py-1.5 text-right font-normal" title={t('accounts.usageSamplesHint')}>
                        {t('accounts.usageColSamples')}
                      </th>
                      <th className="px-2.5 py-1.5 text-right font-normal">{t('accounts.usageColLast')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {models.map((m) => (
                      <tr key={m.model} className="border-t border-border/40">
                        <td className="max-w-[190px] truncate px-2.5 py-1.5" title={m.model}>
                          {m.model}
                        </td>
                        <td className="px-2.5 py-1.5 text-right tabular-nums">
                          {m.cost_per_1k === null ? (
                            <span className="text-muted-foreground">—</span>
                          ) : m.cost_per_1k <= 0 ? (
                            <span className="text-emerald-600 dark:text-emerald-400">
                              {t('accounts.usageFree')}
                            </span>
                          ) : (
                            fmtCostPer1k(m.cost_per_1k)
                          )}
                        </td>
                        <td className="px-2.5 py-1.5 text-right tabular-nums text-muted-foreground">
                          {m.samples ?? '—'}
                        </td>
                        <td className="px-2.5 py-1.5 text-right tabular-nums text-muted-foreground">
                          {m.last_seen ? fmtDateTime(Date.parse(m.last_seen) / 1000) : '—'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <div className="rounded-xl bg-muted px-3 py-3 text-[11px] leading-relaxed text-muted-foreground">
                {t('accounts.usageNoModels')}
              </div>
            )}
          </section>

          {/* 口径说明：不写清楚会被读成「花了多少」 */}
          <div className="flex items-start gap-2 rounded-xl bg-muted px-3 py-2">
            <Info className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
            {/* 译文里用 ** 标重点（项目约定），由 RichText 渲染成 <b> —— 
                直接输出会把星号原样显示出来。 */}
            <span className="text-[11px] leading-relaxed text-muted-foreground">
              <RichText text={t('accounts.usageNote')} />
            </span>
          </div>

          {/* 套餐到期：分批过期，过期即作废 */}
          <section className="space-y-1.5">
            <span className="text-[12px] font-medium">{t('accounts.usageExpiryTitle')}</span>
            {expiries.length ? (
              <ul className="space-y-1">
                {expiries.map((e) => (
                  <li
                    key={`${e.at}-${e.amount}`}
                    className="flex items-center justify-between rounded-lg bg-muted px-3 py-1.5 text-[11px]"
                  >
                    <span className="tabular-nums font-medium">{fmtNumber(e.amount)}</span>
                    <span className="tabular-nums text-muted-foreground">{fmtDateTime(e.at)}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <div className="rounded-xl bg-muted px-3 py-3 text-[11px] leading-relaxed text-muted-foreground">
                {t('accounts.usageNoExpiry')}
              </div>
            )}
          </section>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/**
 * 单价文案。小额要留住有效位数：0.0926 与 0.0035 差 26 倍，统一 `toFixed(1)`
 * 会把两个都显示成 0.1 / 0.0，反而看不出差别——而「看出差别」正是这个弹窗的全部意义。
 */
function fmtCostPer1k(v: number): string {
  if (v < 0.01) return v.toFixed(4);
  if (v < 1) return v.toFixed(3);
  return v.toFixed(2);
}
