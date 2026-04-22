-- Add buyer_email to orders so no-login buyers receive status notification emails.
ALTER TABLE orders
  ADD COLUMN buyer_email TEXT NOT NULL DEFAULT '';
