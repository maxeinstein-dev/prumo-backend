-- P25 L6: notices of the system itself (first one: the Pluggy secret about to expire).
-- Additive: one new value of an existing enum; no row and no other migration changes.
ALTER TYPE "NotificationType" ADD VALUE 'SYSTEM_ALERT';
