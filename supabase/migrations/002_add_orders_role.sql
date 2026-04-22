-- Add ORDERS role to user_role_enum for delivery-only staff members.
-- Must run after migration 001 which created the enum.
ALTER TYPE user_role_enum ADD VALUE 'ORDERS';
