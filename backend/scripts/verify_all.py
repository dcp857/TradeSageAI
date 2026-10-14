"""
Module      : verify_all.py
Date        : 2026-10-14
Author      : TradeSage AI
Synopsis    :
    One-command verification suite for TradeSage AI backend.
    Runs all 5 core smoke tests + live sentiment smoke test in sequence with
    isolated, safe in-memory environment variables (zero API keys required).
    Reports Python version, PyTorch version, LSTM execution mode, and a
    structured summary table. Exits non-zero on any failure.
"""

import os
import sys
import time
import subprocess

backendDir = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
if backendDir not in sys.path:
    sys.path.insert(0, backendDir)

TEST_SCRIPTS = [
    ("smoke_test.py", "SHAP Explainability & Backtesting Logic"),
    ("smoke_test_auth.py", "Authentication, Session Hardening & Demo Flow"),
    ("smoke_test_full.py", "End-to-End Pipeline & Cache Immutability"),
    ("smoke_test_phase3.py", "Watchlist, Feedback Loop & Admin Diagnostics"),
    ("smoke_test_routes.py", "HTTP Route Handlers & Backtest API"),
    ("smoke_test_sentiment.py", "Live Sentiment Engine, VADER & Security Check"),
]


def checkTorchEnvironment():
    try:
        import torch
        torchVer = torch.__version__
        lstmPath = "Real PyTorch execution path (Shallow LSTM: 1-layer, 32 units + SHAP DeepExplainer)"
    except ImportError:
        torchVer = "NOT INSTALLED"
        lstmPath = "Fallback path (PyTorch not installed; LSTM gracefully skipped)"
    return torchVer, lstmPath


def main():
    print("=" * 80)
    print("TRADESAGE AI - AUTOMATED SYSTEM VERIFICATION RUNNER")
    print("=" * 80)

    # 1. Print environment details
    pyVer = f"{sys.version_info.major}.{sys.version_info.minor}.{sys.version_info.micro}"
    torchVer, lstmPath = checkTorchEnvironment()

    print(f"Python Version    : {pyVer} ({sys.executable})")
    print(f"PyTorch Version   : {torchVer}")
    print(f"LSTM Engine Mode  : {lstmPath}")
    print(f"Working Directory : {backendDir}")
    print("=" * 80)
    print()

    # 2. Setup safe isolated environment variables
    testEnv = os.environ.copy()
    testEnv["SECRET_KEY"] = "tradesage-temporary-test-secret-key-12345"
    testEnv["DATABASE_URL"] = "sqlite:///:memory:"
    testEnv["TESTING"] = "1"
    testEnv["FLASK_DEBUG"] = "1"
    testEnv["PYTHONPATH"] = backendDir

    results = []
    totalStart = time.time()

    # 3. Execute all smoke tests in sequence
    for scriptFile, description in TEST_SCRIPTS:
        scriptPath = os.path.join(backendDir, "tests", scriptFile)
        print(f"--> Running: {scriptFile} ({description})...", flush=True)

        startTime = time.time()
        proc = subprocess.run(
            [sys.executable, scriptPath],
            cwd=backendDir,
            env=testEnv,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
        )
        elapsed = time.time() - startTime

        passed = (proc.returncode == 0)
        statusStr = "PASS" if passed else "FAIL"
        results.append({
            "script": scriptFile,
            "description": description,
            "passed": passed,
            "elapsed": elapsed,
            "output": proc.stdout,
        })
        print(f"    [{statusStr}] in {elapsed:.2f}s\n")

    totalElapsed = time.time() - totalStart

    # 4. Print Structured Summary Table
    print("=" * 80)
    print("VERIFICATION SUMMARY REPORT")
    print("=" * 80)
    print(f"{'Script Name':<26} | {'Status':<6} | {'Time (s)':<8} | {'Description'}")
    print("-" * 80)

    allPassed = True
    for r in results:
        statusCol = "PASS" if r["passed"] else "FAIL"
        if not r["passed"]:
            allPassed = False
        print(f"{r['script']:<26} | {statusCol:<6} | {r['elapsed']:>7.2f}s | {r['description']}")

    print("-" * 80)
    totalPassed = sum(1 for r in results if r["passed"])
    print(f"Total Suites: {len(results)} | Passed: {totalPassed} | Failed: {len(results) - totalPassed} | Total Time: {totalElapsed:.2f}s")
    print("=" * 80)

    if not allPassed:
        print("\n[ERROR] One or more test suites failed! Diagnostic failure logs:\n")
        for r in results:
            if not r["passed"]:
                print(f"--- FAILURE IN {r['script']} ---")
                print(r["output"])
                print("-" * 80)
        sys.exit(1)
    else:
        print("\nALL 6 SMOKE TEST SUITES PASSED CLEANLY. SYSTEM READY.")
        sys.exit(0)


if __name__ == "__main__":
    main()
