# 📚 HiDock Next Documentation Index

**Quick navigation to all documentation in the project.**

## 🚀 Getting Started

| Document                             | Purpose                             | Audience               |
| ------------------------------------ | ----------------------------------- | ---------------------- |
| **[QUICK_START.md](QUICK_START.md)** | Simple setup guide with all options | Everyone               |
| **[README.md](README.md)**           | Project overview and quick start    | Everyone               |
| **[docs/SETUP.md](docs/SETUP.md)**   | Detailed setup instructions         | End users + Developers |

## 👨‍💻 Development

| Document                                                         | Purpose                                 | Audience         |
| ---------------------------------------------------------------- | --------------------------------------- | ---------------- |
| **[CONTRIBUTING.md](CONTRIBUTING.md)**                           | Complete contribution guide             | New contributors |
| **[docs/DEVELOPMENT.md](docs/DEVELOPMENT.md)**                   | Development guide and architecture      | Developers       |
| **[docs/VSCODE_CONFIGURATION.md](docs/VSCODE_CONFIGURATION.md)** | VS Code setup and linting configuration | Developers       |
| **[AGENT.md](AGENT.md)**                                         | Instructions for Claude Code AI         | Claude AI        |
| **[docs/PRE-COMMIT.md](docs/PRE-COMMIT.md)**                     | Pre-commit hooks and code quality       | Developers       |

## 📖 Reference Documentation

| Document                                                                           | Purpose                            | Audience   |
| ---------------------------------------------------------------------------------- | ---------------------------------- | ---------- |
| **[docs/API.md](docs/API.md)**                                                     | Complete API documentation         | Developers |
| **[docs/TESTING.md](docs/TESTING.md)**                                             | Testing guide and frameworks       | Developers |
| **[docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md)**                             | Common issues and solutions        | Everyone   |
| **[docs/WINDOW_GEOMETRY_IMPLEMENTATION.md](docs/WINDOW_GEOMETRY_IMPLEMENTATION.md)** | Window position/size saving details | Developers |
| **[docs/SECURITY_RECOMMENDATIONS.md](docs/SECURITY_RECOMMENDATIONS.md)**           | Security best practices            | Developers |
| **[docs/HIDOCK_DESKTOP_TEST_COVERAGE.md](docs/HIDOCK_DESKTOP_TEST_COVERAGE.md)**   | Test coverage analysis             | Developers |
| **[docs/HIDOCK_DESKTOP_DEVELOPMENT.md](docs/HIDOCK_DESKTOP_DEVELOPMENT.md)**       | Desktop app development guide      | Developers |

## 📋 Project Information

| Document                                                                           | Purpose                        | Audience   |
| ---------------------------------------------------------------------------------- | ------------------------------ | ---------- |
| **[docs/ROADMAP.md](docs/ROADMAP.md)**                                             | Future plans and features      | Everyone   |
| **[docs/TECHNICAL_SPECIFICATION.md](docs/TECHNICAL_SPECIFICATION.md)**             | Technical architecture details | Developers |
| **[docs/DEPLOYMENT.md](docs/DEPLOYMENT.md)**                                       | Deployment instructions        | DevOps     |
| **[docs/CLEANUP_REPORT.md](docs/CLEANUP_REPORT.md)**                               | Repository cleanup history     | Developers |
| **[docs/SETTINGS_AND_TEST_IMPROVEMENTS.md](docs/SETTINGS_AND_TEST_IMPROVEMENTS.md)** | Recent settings improvements   | Developers |
| **[docs/DOCUMENTATION_REVIEW_REPORT.md](docs/DOCUMENTATION_REVIEW_REPORT.md)**     | Documentation review status    | Developers |
| **[docs/ACCEPTANCE_CRITERIA.md](docs/ACCEPTANCE_CRITERIA.md)**                     | Project acceptance criteria    | Developers |
| **[docs/REFERENCE_HIDOCK.md](docs/REFERENCE_HIDOCK.md)**                           | Legacy HiDock reference        | Developers |

## 📱 Application-Specific

| Document                                                                     | Purpose                   | Audience       |
| ---------------------------------------------------------------------------- | ------------------------- | -------------- |
| **[apps/desktop/README.md](apps/desktop/README.md)**                         | Desktop application guide (device management)        | Desktop users        |
| **[apps/web/README.md](apps/web/README.md)**                                 | Web application guide (transcription)                | Web users            |
| **[apps/electron/README.md](apps/electron/README.md)**                       | Electron universal knowledge hub (current focus)     | All users            |
| **[apps/meeting-recorder/README.md](apps/meeting-recorder/README.md)**       | Standalone meeting recorder (real-time transcription)| Meeting users        |
| **[legacy/audio-insights/README.md](legacy/audio-insights/README.md)**       | Archived audio insights prototype                    | Reference            |

## 🛠️ Setup Scripts

| File                                       | Purpose                     | Usage                                       |
| ------------------------------------------ | --------------------------- | ------------------------------------------- |
| **[setup.py](setup.py)**                   | Comprehensive setup script  | `python setup.py`                           |
| **[setup-windows.bat](setup-windows.bat)** | Windows one-click setup     | Double-click in Windows                     |
| **[setup-unix.sh](setup-unix.sh)**         | Linux/Mac one-command setup | `chmod +x setup-unix.sh && ./setup-unix.sh` |

## 🎯 Quick Reference by User Type

### **👤 End Users - Just Want to Use HiDock**

1. **[QUICK_START.md](QUICK_START.md)** - Start here
2. **[docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md)** - If you have issues
3. **[apps/desktop/README.md](apps/desktop/README.md)** - Desktop app features
4. **[apps/web/README.md](apps/web/README.md)** - Web app features
5. **[apps/electron/README.md](apps/electron/README.md)** - Electron knowledge hub features

### **👨‍💻 Developers - Want to Contribute**

1. **[CONTRIBUTING.md](CONTRIBUTING.md)** - Start here for contribution guide
2. **[docs/DEVELOPMENT.md](docs/DEVELOPMENT.md)** - Technical development guide
3. **[docs/API.md](docs/API.md)** - API reference
4. **[docs/TESTING.md](docs/TESTING.md)** - Testing guide
5. **[docs/PRE-COMMIT.md](docs/PRE-COMMIT.md)** - Code quality tools
6. **[AGENT.md](AGENT.md)** - For AI development assistance

### **🚀 DevOps - Want to Deploy**

1. **[docs/DEPLOYMENT.md](docs/DEPLOYMENT.md)** - Deployment guide
2. **[docs/TECHNICAL_SPECIFICATION.md](docs/TECHNICAL_SPECIFICATION.md)** - Architecture
3. **[docs/SETUP.md](docs/SETUP.md)** - Environment setup

## 📞 Getting Help

**Can't find what you need?**

- 🐛 **Found a bug?** → [GitHub Issues](https://github.com/sgeraldes/hidock-next/issues)
- ❓ **Have a question?** → [GitHub Discussions](https://github.com/sgeraldes/hidock-next/discussions)
- 💡 **Feature request?** → [GitHub Issues](https://github.com/sgeraldes/hidock-next/issues) with "enhancement" label
- 🔧 **Setup problems?** → [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md)

## 🎯 Recent Updates

**August 5 2025 - Window Geometry Feature:**

- ✅ Window position and size saving implemented
- ✅ Off-screen window detection and automatic correction
- ✅ Debounced auto-save system (500ms timer)
- ✅ Comprehensive geometry validation for multi-monitor setups
- ✅ Complete test coverage for window geometry functionality

**July 30 2025 - Performance Optimization Initiative:**

- ✅ Single/multi selection mode toggle with persistent state
- ✅ Intelligent caching for device (30s) and storage (60s) information
- ✅ Background waveform loading with smart cancellation
- ✅ Deferred selection updates with 150ms debouncing
- ✅ Comprehensive integration tests for performance validation

**August 1 2025 - Code Quality Initiative:**

- ✅ Pre-commit hooks implemented with comprehensive linting
- ✅ Python line length standardized to 120 characters
- ✅ TypeScript strict type checking enforced
- ✅ Test configuration for ignoring test-specific lint issues
- ✅ Automated testing on commit and push

---
*This index is automatically updated with new documentation. Last updated: August 2025*
