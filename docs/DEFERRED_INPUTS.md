# Deferred operator inputs

This checklist records work that is technically ready to continue but requires an operator decision, credential availability, configured destination, or real device.
It intentionally contains no secret values.
Update an item when the required input becomes available, then follow the linked operational guidance before changing production.

## `MASTER_KEY` rotation

Status: blocked on recovery material and an approved maintenance window.

Needed from the operator:

- Confirm that the currently deployed `MASTER_KEY` is backed up in a secret manager.
- Confirm that a fresh D1 backup has been created and can be restored in an isolated environment.
- Choose an acceptable maintenance window for the production migration.
- Approve implementation and use of a dual-key migration workflow before any production key changes.

Do not paste either master key into an issue, pull request, chat transcript, or repository file.
See [Security and secret storage](./SECURITY.md#key-rotation-readiness) and [Backup and restore](./BACKUP.md).

## Web Push verification

Status: blocked on a real browser or installed mobile PWA.

Needed from the operator:

- Choose the browser or Android device that should receive the test.
- Install or open OpenPing on that device and approve notification permission.
- Keep the device available while subscription, delivery, and deep-link behavior are verified.

The verification should cover subscription creation, one real test push, notification display, deep-link navigation, disable and re-enable behavior, and removal.

## Discord verification

Status: blocked because no production Discord notification channel is configured.

Needed from the operator:

- Create or choose a Discord channel for OpenPing test notifications.
- Configure its webhook URL through the OpenPing Integrations page.
- Approve a test delivery and confirm receipt in Discord.

Do not share the Discord webhook URL outside the encrypted channel form because possession of that URL grants delivery capability.

## Real incident and recovery exercise

Status: blocked on the target and disruption plan.

Needed from the operator:

- Choose a service that can be safely made unhealthy or provide a dedicated test endpoint.
- Define the monitor schedule and notification channels for the exercise.
- Decide whether the incident should appear on a public status page.
- Approve the failure window and expected recovery time.

The exercise should verify detection, incident creation, notification delivery, recovery, uptime accounting, and public visibility choices.

## Resend down-and-recovery sequence

Status: provider-level test delivery passed; an incident sequence remains.

Needed from the operator:

- Choose the controlled-failure monitor used by the real incident exercise.
- Confirm that the configured email recipient may receive the down and recovery messages.

This can be completed together with the real incident and recovery exercise.

