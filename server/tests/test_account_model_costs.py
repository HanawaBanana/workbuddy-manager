"""账号「用分单价」台账（上游 `model_costs`）的透传与清洗。

## 为什么需要这些测试

这份台账是账号页「积分详情」弹窗里唯一解释**「为什么这个号掉分特别快」**的数据：
它给的是每个模型在该账号上的**实测单价**（EMA 平滑，线上实测同一模型在不同账号上
差几十倍）。而它的形态完全由上游决定，且会直接显示给用户 —— 清洗一旦漏掉类型校验，
一个 `null` 渗进前端的 `toFixed()` 就会把整个弹窗弄白屏。

所以这里钉两件事：

  · **清洗**：类型不符的行丢掉、缺字段的行降级成 None（而不是让脏值传下去）；
  · **透传**：没有台账的账号必须拿到空列表（前端据此显示空态，而不是 undefined）。
"""
from __future__ import annotations

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from server.services.wb2api import _norm_model_costs, merge_pool_status  # noqa: E402

UID = 'aaaa1111-0000-0000-0000-000000000001'


class NormModelCostsTest(unittest.TestCase):
    def test_sorted_by_cost_desc(self) -> None:
        """贵的排前面 —— 用户最想先看到「哪个模型在烧分」。"""
        raw = [
            {'model': 'cheap', 'cost_per_1k': 0.0035, 'last_seen': 'x', 'samples': 5},
            {'model': 'pricey', 'cost_per_1k': 0.0926, 'last_seen': 'x', 'samples': 1},
        ]
        out = _norm_model_costs(raw)
        self.assertEqual([x['model'] for x in out], ['pricey', 'cheap'])

    def test_missing_cost_sorts_last(self) -> None:
        """单价缺失不代表「便宜」—— 排最后，别混进低价区误导判断。"""
        raw = [
            {'model': 'unknown', 'cost_per_1k': None},
            {'model': 'known', 'cost_per_1k': 0.5},
        ]
        self.assertEqual([x['model'] for x in _norm_model_costs(raw)], ['known', 'unknown'])

    def test_free_tier_is_kept(self) -> None:
        """≤0 = 实测免费，是**有意义的数据**（不是缺失），必须保留原值。"""
        out = _norm_model_costs([{'model': 'free-model', 'cost_per_1k': 0.0}])
        self.assertEqual(len(out), 1)
        self.assertEqual(out[0]['cost_per_1k'], 0.0)

    def test_bad_types_are_dropped_or_nulled(self) -> None:
        """脏值要么整行丢掉，要么降级成 None —— 不能原样送到前端。"""
        raw = [
            'not-a-dict',
            {'cost_per_1k': 1.0},                       # 缺 model → 整行丢
            {'model': '   '},                            # model 全空白 → 整行丢
            {'model': 'ok', 'cost_per_1k': 'oops', 'samples': 'x', 'last_seen': 42},
        ]
        out = _norm_model_costs(raw)
        self.assertEqual(len(out), 1, '只应留下结构完整的那一行')
        self.assertEqual(out[0]['model'], 'ok')
        self.assertIsNone(out[0]['cost_per_1k'], '类型不符的单价应为 None，而不是原样透传')
        self.assertIsNone(out[0]['samples'])
        self.assertIsNone(out[0]['last_seen'])

    def test_bool_is_not_a_number(self) -> None:
        """Python 里 True 是 int 的子类：不显式排除的话 True 会变成单价 1.0。"""
        out = _norm_model_costs([{'model': 'm', 'cost_per_1k': True, 'samples': True}])
        self.assertIsNone(out[0]['cost_per_1k'])
        self.assertIsNone(out[0]['samples'])

    def test_non_list_gives_empty(self) -> None:
        for bad in (None, {}, 'x', 3):
            self.assertEqual(_norm_model_costs(bad), [])


class MergePassesModelCostsTest(unittest.TestCase):
    def _merge(self, pool_item: dict) -> dict:
        accounts = [{'uid': UID, 'file': f'workbuddy-{UID}.json'}]
        status = {'accounts': [{'uid': UID, **pool_item}]}
        return merge_pool_status(accounts, status)[0]

    def test_account_in_pool_gets_list(self) -> None:
        a = self._merge({'model_costs': [
            {'model': 'm1', 'cost_per_1k': 0.01, 'last_seen': '2026-09-23T10:00:00+08:00', 'samples': 3},
        ]})
        self.assertEqual(len(a['model_costs']), 1)
        self.assertEqual(a['model_costs'][0]['model'], 'm1')

    def test_account_without_record_gets_empty_list(self) -> None:
        """给空列表而不是缺字段：前端两处视图都直接读它渲染空态。"""
        self.assertEqual(self._merge({})['model_costs'], [])

    def test_account_not_in_pool_gets_empty_list(self) -> None:
        """上游没加载这个账号时它连 /status 条目都没有 —— 同样要给空列表。"""
        accounts = [{'uid': UID, 'file': f'workbuddy-{UID}.json'}]
        out = merge_pool_status(accounts, {'accounts': []})[0]
        self.assertEqual(out['model_costs'], [])


if __name__ == '__main__':
    unittest.main()
