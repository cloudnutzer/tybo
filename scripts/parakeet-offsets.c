/*
 * Struktur-Offsets der C-API von sherpa-onnx für den Erkennungsprozess
 * (src/lib/speech/parakeet_worker.ts, Issue #257). Nur nach einem Wechsel von
 * SHERPA_VERSION nötig, von Hand:
 *
 *   cc -I <sherpa-onnx-v…>/include scripts/parakeet-offsets.c -o /tmp/offsets && /tmp/offsets
 *
 * Die Ausgabe muss zu RECOGNIZER_CONFIG in parakeet_worker.ts passen
 * (1.13.8: size=608, encoder=8, tokens=104, provider=120, model_type=128,
 * decoding_method=528, max_active_paths=536, result.text=0).
 */
#include <stddef.h>
#include <stdio.h>

#include "sherpa-onnx/c-api/c-api.h"

#define O(f) printf("%s=%zu\n", #f, offsetof(SherpaOnnxOfflineRecognizerConfig, f))

int main(void) {
  printf("size=%zu\n", sizeof(SherpaOnnxOfflineRecognizerConfig));
  O(feat_config.sample_rate);
  O(feat_config.feature_dim);
  O(model_config.transducer.encoder);
  O(model_config.transducer.decoder);
  O(model_config.transducer.joiner);
  O(model_config.tokens);
  O(model_config.num_threads);
  O(model_config.debug);
  O(model_config.provider);
  O(model_config.model_type);
  O(decoding_method);
  O(max_active_paths);
  printf("result.text=%zu\n", offsetof(SherpaOnnxOfflineRecognizerResult, text));
  return 0;
}
