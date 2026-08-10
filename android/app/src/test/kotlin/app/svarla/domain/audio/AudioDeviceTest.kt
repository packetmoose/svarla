package app.svarla.domain.audio

import io.kotest.core.spec.style.FunSpec
import io.kotest.matchers.shouldBe
import io.kotest.property.Arb
import io.kotest.property.arbitrary.element
import io.kotest.property.arbitrary.set
import io.kotest.property.checkAll

class AudioDeviceTest : FunSpec({

    context("AudioDevice.highestPriority") {

        test("returns earpiece when only earpiece is available") {
            val result = AudioDevice.highestPriority(setOf(AudioDevice.EARPIECE))
            result shouldBe AudioDevice.EARPIECE
        }

        test("returns wired headphones when wired and earpiece are available") {
            val result = AudioDevice.highestPriority(
                setOf(AudioDevice.EARPIECE, AudioDevice.WIRED_HEADPHONES)
            )
            result shouldBe AudioDevice.WIRED_HEADPHONES
        }

        test("returns wired headphones when all devices are available") {
            val result = AudioDevice.highestPriority(
                setOf(AudioDevice.EARPIECE, AudioDevice.BLUETOOTH, AudioDevice.WIRED_HEADPHONES, AudioDevice.SPEAKER)
            )
            result shouldBe AudioDevice.WIRED_HEADPHONES
        }

        test("returns bluetooth when bluetooth and earpiece are available") {
            val result = AudioDevice.highestPriority(
                setOf(AudioDevice.EARPIECE, AudioDevice.BLUETOOTH)
            )
            result shouldBe AudioDevice.BLUETOOTH
        }

        test("returns wired headphones over bluetooth") {
            val result = AudioDevice.highestPriority(
                setOf(AudioDevice.BLUETOOTH, AudioDevice.WIRED_HEADPHONES)
            )
            result shouldBe AudioDevice.WIRED_HEADPHONES
        }

        test("speaker alone does not get auto-selected — falls back to earpiece") {
            val result = AudioDevice.highestPriority(setOf(AudioDevice.SPEAKER))
            result shouldBe AudioDevice.EARPIECE
        }

        test("empty set falls back to earpiece") {
            val result = AudioDevice.highestPriority(emptySet())
            result shouldBe AudioDevice.EARPIECE
        }

        test("speaker with earpiece selects earpiece (speaker excluded from auto-routing)") {
            val result = AudioDevice.highestPriority(
                setOf(AudioDevice.SPEAKER, AudioDevice.EARPIECE)
            )
            result shouldBe AudioDevice.EARPIECE
        }
    }

    context("AudioDevice priority ordering") {

        test("wired headphones has highest priority") {
            AudioDevice.WIRED_HEADPHONES.priority shouldBe 3
        }

        test("bluetooth has second highest priority") {
            AudioDevice.BLUETOOTH.priority shouldBe 2
        }

        test("earpiece has third priority") {
            AudioDevice.EARPIECE.priority shouldBe 1
        }

        test("speaker has lowest priority") {
            AudioDevice.SPEAKER.priority shouldBe 0
        }
    }

    context("Property 25: Audio Device Priority Selection") {
        /**
         * **Validates: Requirements 10.3**
         *
         * For any set of currently available audio output devices, the system SHALL route
         * audio to the highest-priority device according to the fixed order:
         * wired headphones > Bluetooth headset > earpiece.
         * Speaker is excluded from automatic selection (only via manual toggle).
         */
        test("property: highest priority device is always selected from any subset") {
            val deviceArb = Arb.element(AudioDevice.entries.toList())
            val deviceSetArb = Arb.set(deviceArb, 1..4)

            checkAll(100, deviceSetArb) { devices ->
                val result = AudioDevice.highestPriority(devices)

                // Speaker should never be auto-selected
                if (devices.any { it != AudioDevice.SPEAKER }) {
                    result shouldBe when {
                        AudioDevice.WIRED_HEADPHONES in devices -> AudioDevice.WIRED_HEADPHONES
                        AudioDevice.BLUETOOTH in devices -> AudioDevice.BLUETOOTH
                        else -> AudioDevice.EARPIECE
                    }
                }
            }
        }

        test("property: result is always a non-speaker device or earpiece fallback") {
            val deviceArb = Arb.element(AudioDevice.entries.toList())
            val deviceSetArb = Arb.set(deviceArb, 0..4)

            checkAll(100, deviceSetArb) { devices ->
                val result = AudioDevice.highestPriority(devices)
                // Result should never be SPEAKER (it's excluded from auto-routing)
                (result != AudioDevice.SPEAKER) shouldBe true
            }
        }

        test("property: if wired headphones present, always selected") {
            val deviceArb = Arb.element(AudioDevice.entries.toList())
            val deviceSetArb = Arb.set(deviceArb, 0..3)

            checkAll(100, deviceSetArb) { otherDevices ->
                val devices = otherDevices + AudioDevice.WIRED_HEADPHONES
                val result = AudioDevice.highestPriority(devices)
                result shouldBe AudioDevice.WIRED_HEADPHONES
            }
        }

        test("property: if bluetooth present but no wired, bluetooth selected") {
            val deviceArb = Arb.element(
                listOf(AudioDevice.BLUETOOTH, AudioDevice.EARPIECE, AudioDevice.SPEAKER)
            )
            val deviceSetArb = Arb.set(deviceArb, 0..2)

            checkAll(100, deviceSetArb) { otherDevices ->
                val devices = otherDevices + AudioDevice.BLUETOOTH
                // Ensure no wired headphones
                val filtered = devices - AudioDevice.WIRED_HEADPHONES
                val withBluetooth = filtered + AudioDevice.BLUETOOTH
                val result = AudioDevice.highestPriority(withBluetooth)
                result shouldBe AudioDevice.BLUETOOTH
            }
        }
    }
})
