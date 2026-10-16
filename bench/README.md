# Latency bench

Measures keystroke-to-echo time over a simulated link, so typing in blimp can be compared with plain `ssh`.

1. Make a network sandbox with a 40 ms round trip to this machine (needs sudo; only traffic on its own link is delayed):
   `sudo sh bench/netns.sh 20` (20 ms each way)
2. Start a test session running `cat`: `env -u ZMX_SESSION zmx attach blimptest-lat cat </dev/null`
3. Run from inside the sandbox, as yourself:
   - today's path: `sudo ip netns exec blimplat sudo -u $USER env HOME=$HOME PATH=$PATH bun bench/latency.ts ssh $USER@10.77.0.1 blimptest-lat`
   - blimp's path: same, with `blimp $USER@10.77.0.1 blimptest-lat <blimpd socket> <token>`
4. `zmx kill blimptest-lat` and `sudo ip netns del blimplat` when done.

"spaced" types one key every 150 ms (the base round trip). "burst" types one every 25 ms (fast typing).
