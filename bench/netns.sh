#!/bin/sh
# A network namespace "blimplat" joined to this machine by a veth pair with <ms> of delay each way.
# This machine is 10.77.0.1, the sandbox is 10.77.0.2. Only traffic on that link is delayed.
#   sudo sh bench/netns.sh [ms]
set -eu
d=${1:-20}
ip netns add blimplat 2>/dev/null || true
ip link show blv0 >/dev/null 2>&1 || {
  ip link add blv0 type veth peer name blv1
  ip link set blv1 netns blimplat
  ip addr add 10.77.0.1/24 dev blv0
  ip netns exec blimplat ip addr add 10.77.0.2/24 dev blv1
}
ip link set blv0 up
ip netns exec blimplat ip link set blv1 up
ip netns exec blimplat ip link set lo up
tc qdisc replace dev blv0 root netem delay "${d}ms"
ip netns exec blimplat tc qdisc replace dev blv1 root netem delay "${d}ms"
ip netns exec blimplat ping -c 3 -q 10.77.0.1 | tail -1
