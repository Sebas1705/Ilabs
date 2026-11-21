plugins {
    alias(libs.plugins.kotlin.multiplatform)
    alias(libs.plugins.kotlin.serialization)
    alias(libs.plugins.android.kmp.library)
}

kotlin {
    jvmToolchain(21)

    jvm()

    android {
        namespace = "es.sebas1705.ilabs.guardrails"
        compileSdk = 36
        minSdk = 24

        withHostTest {}
    }

    sourceSets {
        commonMain.dependencies {
            api(project(":modules:providers-kotlin"))
            api(project(":modules:rag-kotlin"))
            // Only the fixture harness (`...guardrails.contract`) uses structured, for strict JSON parsing of fixture
            // files; `parsePolicy(String)` uses it too, to parse a policy given as a string.
            implementation(project(":modules:structured-kotlin"))
            api(libs.kotlinx.coroutines.core)
            api(libs.kotlinx.serialization.json)
        }
        commonTest.dependencies {
            implementation(kotlin("test"))
            implementation(libs.kotlinx.coroutines.test)
        }
    }
}

// Gradle does not know the shared fixtures are test inputs: declare them so a fixture-only edit reruns the tests.
tasks.withType<Test>().configureEach {
    inputs.files(rootProject.fileTree("contracts/guardrails") { include("*.json") })
        .withPropertyName("contractFixtures")
        .withPathSensitivity(PathSensitivity.RELATIVE)
}
