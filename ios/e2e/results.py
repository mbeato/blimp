# Where the UI test run stands, from xcodebuild's log, for the app-e2e job's watch on it: "running" until
# every test has its last word (passed, or failed on its second go: the job runs a failed test once more),
# then "passed" if each one's last result is a pass, else "failed".
#   python3 ios/e2e/results.py <xcodebuild.log> <test> ...
import re
import sys

log, tests = sys.argv[1], sys.argv[2:]
results = {t: [] for t in tests}
for line in open(log, errors="replace"):
    m = re.search(r"Test Case '-\[BlimpUITests\.BlimpUITests (\w+)\]' (passed|failed)", line)
    if m and m.group(1) in results:
        results[m.group(1)].append(m.group(2))
done = all(r and (r[-1] == "passed" or r.count("failed") >= 2) for r in results.values())
print("running" if not done else "passed" if all(r[-1] == "passed" for r in results.values()) else "failed")
