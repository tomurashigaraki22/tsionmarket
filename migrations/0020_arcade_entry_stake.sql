-- Rounds stop being free.
--
-- 1 USDC is deliberately low: the point of the first staked release is that
-- people try it, not that anyone wins big. Three players minimum makes a 3
-- USDC pot, which is a real stake without being a sum anyone needs to think
-- hard about. Raise it once the game has a track record.
--
-- The house takes nothing from the pot at this entry size: a rake on 3 USDC
-- is rounding, and taking it would cost more goodwill than it earns. The
-- deposit fee is where the house is paid, and it is disclosed before anyone
-- sends anything.
UPDATE arcade_games
SET entry_amount = 1.000000000000000000,
    rake_bps = 0
WHERE id = 'last-man';
