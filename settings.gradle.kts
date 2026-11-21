rootProject.name = "ilabs"

pluginManagement {
    repositories {
        google {
            mavenContent {
                includeGroupAndSubgroups("androidx")
                includeGroupAndSubgroups("com.android")
                includeGroupAndSubgroups("com.google")
            }
        }
        mavenCentral()
        gradlePluginPortal()
    }
}

dependencyResolutionManagement {
    repositories {
        google {
            mavenContent {
                includeGroupAndSubgroups("androidx")
                includeGroupAndSubgroups("com.android")
                includeGroupAndSubgroups("com.google")
            }
        }
        mavenCentral()
    }
}

include(":modules:providers-kotlin")
project(":modules:providers-kotlin").projectDir = file("modules/providers/kotlin")

include(":modules:structured-kotlin")
project(":modules:structured-kotlin").projectDir = file("modules/structured/kotlin")

include(":modules:context-kotlin")
project(":modules:context-kotlin").projectDir = file("modules/context/kotlin")

include(":modules:evals-kotlin")
project(":modules:evals-kotlin").projectDir = file("modules/evals/kotlin")

include(":modules:rag-kotlin")
project(":modules:rag-kotlin").projectDir = file("modules/rag/kotlin")

include(":modules:guardrails-kotlin")
project(":modules:guardrails-kotlin").projectDir = file("modules/guardrails/kotlin")

include(":modules:vision-kotlin")
project(":modules:vision-kotlin").projectDir = file("modules/vision/kotlin")

include(":demos:android")
