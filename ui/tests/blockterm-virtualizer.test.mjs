import assert from "node:assert/strict";
import test from "node:test";
import { Virtualizer } from "@tanstack/react-virtual";

function createVirtualizerHarness(blocks) {
  let offsetCallback = null;
  const scrollElement = {
    scrollTop: 0,
    scrollLeft: 0,
    scrollHeight: 0,
    scrollWidth: 1024,
    clientHeight: 640,
    clientWidth: 1024,
    offsetHeight: 640,
    offsetWidth: 1024,
    ownerDocument: { defaultView: null },
    addEventListener() {},
    removeEventListener() {},
    getBoundingClientRect() {
      return { width: this.clientWidth, height: this.clientHeight };
    },
    scrollTo({ top }) {
      this.scrollTop = top;
      offsetCallback?.(top, false);
    },
  };
  const targetWindow = {
    ResizeObserver: undefined,
    performance: { now: () => Date.now() },
    requestAnimationFrame: (callback) => setTimeout(callback, 0),
    cancelAnimationFrame: (id) => clearTimeout(id),
    setTimeout,
    clearTimeout,
  };
  scrollElement.ownerDocument.defaultView = targetWindow;

  const virtualizer = new Virtualizer({
    count: blocks.length,
    getScrollElement: () => scrollElement,
    getItemKey: (index) => blocks[index]?.id ?? index,
    estimateSize: (index) => {
      const block = blocks[index];
      if (!block || block.collapsed) return 54;
      return block.mode === "terminal" ? 480 : 120;
    },
    initialRect: { width: 1024, height: 640 },
    observeElementRect: (_instance, callback) => {
      callback({ width: 1024, height: 640 });
      return () => {};
    },
    observeElementOffset: (_instance, callback) => {
      offsetCallback = callback;
      callback(scrollElement.scrollTop, false);
      return () => {
        offsetCallback = null;
      };
    },
    scrollToFn: (offset) => scrollElement.scrollTo({ top: offset }),
    overscan: 4,
    scrollPaddingStart: 52,
    scrollPaddingEnd: 16,
  });

  virtualizer._willUpdate();
  const syncScrollHeight = () => {
    scrollElement.scrollHeight = virtualizer.getTotalSize();
  };
  syncScrollHeight();
  return {
    virtualizer,
    scrollElement,
    syncScrollHeight,
    cleanup: virtualizer._didMount(),
  };
}

function assertContiguousMeasurements(virtualizer, expectedSizes) {
  const measurements = virtualizer.getMeasurements();
  assert.equal(measurements.length, expectedSizes.length);
  for (let index = 0; index < measurements.length; index += 1) {
    const measurement = measurements[index];
    assert.equal(measurement.size, expectedSizes[index], `size at ${index}`);
    assert.equal(measurement.start, index === 0 ? 0 : measurements[index - 1].end, `start at ${index}`);
    assert.equal(measurement.end, measurement.start + expectedSizes[index], `end at ${index}`);
  }
}

test("handles 1000 BlockTerm rows with heterogeneous dynamic heights", () => {
  const blocks = Array.from({ length: 1000 }, (_, index) => ({
    id: `block-${index}`,
    mode: index % 5 === 0 ? "terminal" : "text",
    collapsed: index % 17 === 0,
  }));
  const actualSizes = blocks.map((block, index) => {
    if (block.collapsed) return 54 + (index % 4);
    if (block.mode === "terminal") return 180 + ((index * 37) % 521);
    return 40 + ((index * 29) % 201);
  });
  const harness = createVirtualizerHarness(blocks);
  const measured = new Set();

  try {
    const measureVisibleRows = () => {
      for (const row of harness.virtualizer.getVirtualItems()) {
        harness.virtualizer.resizeItem(row.index, actualSizes[row.index]);
        measured.add(row.index);
      }
      harness.syncScrollHeight();
    };

    measureVisibleRows();
    let iterations = 0;
    while (measured.size < blocks.length && iterations < 2000) {
      let nextIndex = 0;
      while (nextIndex < blocks.length && measured.has(nextIndex)) nextIndex += 1;
      if (nextIndex >= blocks.length) break;
      harness.virtualizer.scrollToIndex(nextIndex, { align: "start" });
      harness.syncScrollHeight();
      measureVisibleRows();
      iterations += 1;
    }

    assert.equal(measured.size, blocks.length, "every row should become measurable");
    assert.equal(iterations < 2000, true);
    assert.equal(
      harness.virtualizer.getTotalSize(),
      actualSizes.reduce((sum, size) => sum + size, 0),
      "measured total height should equal the sum of row heights"
    );
    assertContiguousMeasurements(harness.virtualizer, actualSizes);

    // Streaming output can change a row after it has already been measured.
    // Apply changes in reverse order to exercise recalculation from arbitrary
    // positions rather than only from the first visible row.
    for (let index = blocks.length - 1; index >= 0; index -= 1) {
      actualSizes[index] += index % 7 === 0 ? 33 : -Math.min(actualSizes[index] - 1, index % 5);
      harness.virtualizer.resizeItem(index, actualSizes[index]);
    }
    harness.syncScrollHeight();
    assert.equal(
      harness.virtualizer.getTotalSize(),
      actualSizes.reduce((sum, size) => sum + size, 0),
      "dynamic remeasurement should update total height"
    );
    assertContiguousMeasurements(harness.virtualizer, actualSizes);

    for (const index of [0, 1, 37, 512, 999]) {
      harness.virtualizer.scrollToIndex(index, { align: "start" });
      harness.syncScrollHeight();
      const measurements = harness.virtualizer.getMeasurements();
      const expectedOffset = Math.max(
        0,
        Math.min(
          harness.scrollElement.scrollHeight - harness.scrollElement.clientHeight,
          measurements[index].start - 52
        )
      );
      assert.equal(harness.scrollElement.scrollTop, expectedOffset, `scroll offset for row ${index}`);
      assert.equal(
        harness.virtualizer.getVirtualItems().some((item) => item.index === index),
        true,
        `target row ${index} should be rendered`
      );
    }
  } finally {
    harness.cleanup();
  }
});
