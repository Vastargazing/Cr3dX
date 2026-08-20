#!/usr/bin/env python3
"""Run the frozen blind v0.4.8 reference-model harness."""

import unittest


if __name__ == "__main__":
    suite = unittest.defaultTestLoader.discover(".", pattern="test_reference_model.py")
    result = unittest.TextTestRunner(verbosity=2).run(suite)
    raise SystemExit(0 if result.wasSuccessful() else 1)
