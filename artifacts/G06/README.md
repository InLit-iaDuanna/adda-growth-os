# G06 evidence

会员分群、冻结受众、持久化 holdout、触达审批和发送前政策检查均使用合成会员/订单/同意事件与本地 test outbox。未调用真实短信、邮件或 WhatsApp；没有真实凭据和许可接收人时，生产路径明确返回 `external_blocked`。
