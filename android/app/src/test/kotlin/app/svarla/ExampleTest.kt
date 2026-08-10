package app.svarla

import io.kotest.core.spec.style.FunSpec
import io.kotest.matchers.shouldBe

class ExampleTest : FunSpec({
    test("application package name is correct") {
        val packageName = "app.svarla"
        packageName shouldBe "app.svarla"
    }
})
