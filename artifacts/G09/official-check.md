# WhatsApp capability check (2026-09-22)

The implementation remains `manual/unconfigured` by default. The official WhatsApp Business pages state that programmatic initiation requires customer opt-in and customizable message templates.

- https://business.whatsapp.com/products/business-platform-features
- https://business.whatsapp.com/resources/resource-library/api-onboarding
- https://business.whatsapp.com/products/conversation-categories/utility

The local adapter therefore requires server-side credentials, webhook secret, active template capability, consent and a persisted approval intent. No real provider request was made in this environment.
