# Threadline backend follow-up

The GitHub Pages app now includes the installed-app service worker, notification
display logic, offline shell cache, and retry queue. Two upgrades still need a
trusted backend before they can be fully live:

## Closed-app push delivery

1. Generate a VAPID key pair on a trusted server.
2. Store each installed app's `PushSubscription` with its Threadline handle.
3. When a new message or ringing call is inserted, send a web-push payload to
   the recipient's subscriptions.
4. Keep the VAPID private key on the server only.

The service worker accepts message and call push payloads already.

## Secure cross-device accounts

1. Add Supabase Auth or another server-side authentication provider.
2. Store profiles, recovery email addresses, favorites, blocks, mute rules, and
   group pictures behind authenticated row-level security policies.
3. Hash passcodes on the server with a password hashing algorithm. Do not store
   passcodes or recovery codes in client-side JavaScript.
4. Add a server-side email provider for password recovery codes.

The current local profile and digits-only device lock remain useful as a
device-level convenience lock until authenticated accounts are connected.
