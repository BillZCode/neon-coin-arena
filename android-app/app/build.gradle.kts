plugins {
  alias(libs.plugins.android.application)
}

android {
  namespace = "com.neoncoinarena.game"
  compileSdk = 35

  defaultConfig {
    applicationId = "com.neoncoinarena.game"
    minSdk = 24
    targetSdk = 35
    versionCode = 1
    versionName = "1.0.0"
  }

  val releaseKeystorePath = System.getenv("KEYSTORE_FILE")
  val hasReleaseKeystore = !releaseKeystorePath.isNullOrBlank() && file(releaseKeystorePath).exists()

  signingConfigs {
    if (hasReleaseKeystore) {
      create("release") {
        storeFile = file(releaseKeystorePath!!)
        storePassword = System.getenv("KEYSTORE_PASS") ?: ""
        keyAlias = System.getenv("KEY_ALIAS") ?: ""
        keyPassword = System.getenv("KEY_PASS") ?: storePassword
      }
    }
  }

  buildTypes {
    release {
      isMinifyEnabled = false
      if (hasReleaseKeystore) {
        signingConfig = signingConfigs.getByName("release")
      }
    }
  }

  compileOptions {
    sourceCompatibility = JavaVersion.VERSION_17
    targetCompatibility = JavaVersion.VERSION_17
  }

  buildFeatures {
    compose = false
    aidl = false
    buildConfig = false
    shaders = false
  }
}

kotlin {
  jvmToolchain(17)
}
