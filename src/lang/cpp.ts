import * as cp from 'child_process'
import { pathExists, ensureFile, ensureDir, copy } from 'fs-extra'
import { CaseList, existFile, readFileAsync, TestCase, TestCaseParam, writeFileAsync } from '../common/util'
import { tag } from 'pretty-tag'
import { getFuncNames, parseTestCase, TestResult, handleMsg } from '../common/util'
import { log, config } from '../config'
import { getDb } from '../db';
import { api } from '../api/index'
import { MetaData } from '../util'
import { resolve } from 'path'
import { rejects } from 'assert'
import { runInNewContext } from 'vm'
import { promisify } from 'util'
import { OutputChannel } from 'vscode'
import * as vscode from 'vscode'
import { tranfromToCustomBreakpoint } from '../debug/launch'
import { stdout } from 'process'
import * as path from 'path'
import { ExtraType } from '../common/langConfig'
import { BaseLang } from './base'
import { parseCommentTest } from '../common/util'
const execFileAsync = promisify(cp.execFile)
const langTypeMap: Record<string, string> = {
    'integer': 'int',
    'string': 'string',
    'boolean': 'bool',
    'integer[]': 'vector<int>',
    'string[]': 'vector<string>',
    'integer[][]': 'vector<vector<int>>',
    'double': 'double',
    'ListNode': 'ListNode *',
    'TreeNode': 'TreeNode *',
    'ListNode[]': 'vector<ListNode *>',
    'TreeNode[]': 'vector<TreeNode *>',
    'character[][]': 'vector<vector<string>>',
    'string[][]': 'vector<vector<string>>',
    'list<integer>': 'vector<int>',
    'list<string>': 'vector<string>',
    'list<list<integer>>': 'vector<vector<int>>',
    'list<list<string>>': 'vector<vector<string>>',
    'list<ListNode>': 'vector<ListNode *>',
    'list<TreeNode>': 'vector<TreeNode *>'
}

export class CppParse extends BaseLang {
    // static preImport: string = 'package main'
    static getPreImport(name: string, extraTypeSet: Set<ExtraType>) {

        return tag`
        #include <iostream>
        #include <vector>
        #include <string>
        #include "algm/algm.h"
        using namespace std;
        `
    }
    funcRegExp = /^(\s*class Solution)/
    testRegExp = /\/\/\s*@test\(((?:"(?:\\.|[^"])*"|[^)])*)\)/
    private cwd: string
    private mainFilePath: string
    constructor(public filePath: string, public text?: string) {
        super(filePath, text)
        this.cwd = path.join(filePath, '..', '..')
        this.mainFilePath = path.join('main', 'main.cpp')
    }
    handleParam(index: number, paramType: string): string {
        const langType = langTypeMap[paramType]
        if (!langType) {
            throw new Error("not support param type:" + paramType)
        }
        const handleConfig = [{
            type: 'integer',
            handleFn: 'parseInteger'
        }, {
            type: 'string',
            handleFn: 'parseString'
        }, {
            type: 'integer[]',
            handleFn: 'parseIntegerArr'
        }, {
            type: 'string[]',
            handleFn: 'parseStringArr'
        }, {
            type: 'integer[][]',
            handleFn: 'parseIntegerArrArr'
        }, {
            type: 'double',
            handleFn: 'parseFloat'
        }, {
            type: "ListNode",
            handleFn: "parseListNode"
        }, {
            type: "TreeNode",
            handleFn: "parseTreeNode"
        }, {
            type: "ListNode[]",
            handleFn: "parseListNodeArr"
        }, {
            type: "TreeNode[]",
            handleFn: "parseTreeNodeArr"
        }, {
            type: "character[][]",
            handleFn: "parseStringArrArr"
        }, {
            type: "string[][]",
            handleFn: "parseStringArrArr"
        }, {
            type: "list<string>",
            handleFn: 'parseStringArr'
        }, {
            type: 'list<list<string>>',
            handleFn: 'parseStringArrArr'
        }, {
            type: 'list<integer>',
            handleFn: 'parseIntegerArr'
        }, {
            type: 'list<list<integer>>',
            handleFn: 'parseIntegerArrArr'
        }]
        for (const { type, handleFn } of handleConfig) {
            if (type === paramType) {
                return `${langType} arg${index} = ${handleFn}(args[${index}]);`
            }
        }
        throw new Error(`paramType ${paramType} not support`)
    }
    handleReturn(paramCount: number, funcName: string, returnType: string, firstParamType: string): string {
        let isVoid = returnType === 'void'
        if (isVoid) {
            returnType = firstParamType
        }
        const langType = langTypeMap[returnType]
        if (!langType) {
            throw new Error("not support return type:" + returnType)
        }
        const handleConfig = [{
            type: 'integer',
            handleFn: 'serializeInteger',
        }, {
            type: 'string',
            handleFn: 'serializeString',
        }, {
            type: 'double',
            handleFn: 'serializeFloat',
        }, {
            type: 'boolean',
            handleFn: 'serializeBool',
        }, {
            type: "ListNode",
            handleFn: "serializeListNode"
        }, {
            type: "TreeNode",
            handleFn: "serializeTreeNode"
        },
        {
            type: 'integer[]',
            handleFn: 'serializeIntegerArr'
        }, {
            type: 'list<integer>',
            handleFn: 'serializeIntegerArr'
        },
        {
            type: 'string[]',
            handleFn: 'serializeStringArr'
        }, {
            type: 'list<string>',
            handleFn: 'serializeStringArr'
        },
        {
            type: "ListNode[]",
            handleFn: "serializeListNodeArr"
        }, {
            type: "TreeNode[]",
            handleFn: "serializeTreeNodeArr"
        }, {
            type: 'integer[][]',
            handleFn: 'serializeIntegerArrArr'
        },
        {
            type: 'list<list<integer>>',
            handleFn: 'serializeIntegerArrArr'
        },
        {
            type: "character[][]",
            handleFn: "serializeStringArrArr"
        }, {
            type: "string[][]",
            handleFn: "serializeStringArrArr"
        }, {
            type: 'list<list<string>>',
            handleFn: 'serializeStringArrArr'
        }]
        const argStr = Array(paramCount).fill(0).map((_, i) => `arg${i}`).join(',')

        for (const { type, handleFn } of handleConfig) {
            if (type === returnType) {
                if (!isVoid) {
                    const funcExpression = tag`
                    ${langType} result=s->${funcName}(${argStr});
                    string resultabc =${handleFn}(result);
                    `
                    return funcExpression
                } else {
                    const funcExpression = tag`
                    s->${funcName}(${argStr});
                    string resultabc =${handleFn}(arg0);
                    `
                    return funcExpression
                }


            }
        }
        throw new Error(`returnType ${returnType} not support`)
    }


    async handleArgsType() {
        const meta = await this.getQuestionMeta()
        if (!meta) {
            throw new Error('question meta not found')
        }
        const params = meta.params || []
        let rt = meta.return.type
        const funcName = meta.name
        const argExpressions: string[] = []
        const paramCount = params.length
        for (let i = 0; i < paramCount; i++) {
            const { name, type } = params[i]
            argExpressions[i] = this.handleParam(i, type)

        }

        const name = path.parse(this.filePath).name
        const argExpression = argExpressions.join('\n')
        const rtExpression = this.handleReturn(paramCount, funcName, rt, params[0].type)

        return tag`
        #include "question/${name}.cpp"
        #include "regex"
        #include "algm/parse.h"
        int main(int argc, char *argv[])
        {
            string str = argv[1];
            vector<vector<string>> arr = parseStringArrArr(str);
            for (int i = 0; i < arr.size(); i++)
            {
              // cout<<arr[i][0]<<endl;
              vector<string> args = arr[i];
              Solution *s = new Solution();
              ${argExpression}
              ${rtExpression}
              cout << "resultabc"+to_string(i)+":" << resultabc <<"resultend"<< endl;
            }
            return 0;
        } 
            `


    }

    private async ensureCommonModuleFile() {
        // const dir = config.
        const algmDir = path.resolve(this.filePath, '..', '..', 'algm')
        // const files = await readdirAsync(algmDir)
        const sourceDir = path.resolve(__dirname, '..', '..', 'template', 'cpp')
        const names = ['algm.h', 'ListNode.h', 'TreeNode.h', 'parse.h']

        await Promise.all(names.map(async name => {
            const src = path.join(sourceDir, name)
            const dst = path.join(algmDir, name)
            const isExist = await pathExists(dst)
            if (!isExist) {
                return copy(src, dst)
            }

        }))
    }
    async runMultiple(caseList: CaseList, originCode: string, funcName: string) {
        const argsArr = caseList.map(v => v.args)
        await this.buildMainFile()
        const cwd = this.cwd
        try {
            const { stdout, stderr } = await execFileAsync('./main/main', [JSON.stringify(argsArr).replace(/"|\\|\s/g, (s) => `\\${s}`)], { timeout: 10000, cwd: cwd, shell: true })
            let testResultList = this.handleResult(stdout, caseList)
            return handleMsg(testResultList)
        } catch (err) {
            log.appendLine(err)
        }
    }
    async runInNewContext(args: string[], originCode: string, funcName: string) {
        return ''
    }
    async handlePreImport() {
        await this.ensureCommonModuleFile()
        return
    }


    // do some thing before debug,eg. get testcase 
    async beforeDebug(breaks: vscode.SourceBreakpoint[]) {
        await this.buildMainFile()
    }
    async buildMainFile() {
        await this.writeTestCase()
        const cppPath = 'g++'
        const dir = path.parse(this.filePath).dir
        const dirParse = path.parse(dir)
        const cwd = dirParse.dir
        const mainFilePath = this.mainFilePath
        await execFileAsync(cppPath, ['-I', '.', '-g', mainFilePath, '-o', 'main/main'], { timeout: 10000, cwd: cwd, shell: true })
    }
    private getTestFilePath() {
        const testFilePath = path.join(this.filePath, '..', '..', 'main', 'main.cpp')
        return testFilePath
    }
    async writeTestCase() {

        await this.ensureCommonModuleFile()
        const finalCode = await this.handleArgsType()
        const testFilePath = this.getTestFilePath()
        await ensureFile(testFilePath)
        await writeFileAsync(testFilePath, finalCode)
    }
    async getDebugConfig(breaks: vscode.SourceBreakpoint[]) {
        const filePath = this.filePath
        const customBreakpoints = tranfromToCustomBreakpoint(breaks)
        const customBreakPoint = customBreakpoints.find(c => c.path === filePath)
        if (!customBreakPoint) {
            throw new Error('breakpoint not found, please set breakpoint first')
        }
        const originCode = await this.getOriginCode()
        const questionMeta = await this.getQuestionMeta()
        if (!questionMeta) {
            throw new Error('questionMeta not found ')
        }
        const funcName = questionMeta.name
        let codeLines = originCode.split('\n')

        const lines = customBreakPoint.lines
        const line = lines.find(num => this.testRegExp.test(codeLines[num]))
        if (!Number.isInteger(line)) {
            throw new Error('please select the test case')
        }
        const { args } = parseCommentTest(codeLines[(line as number)])
        const cwd = this.cwd
        return {
            "name": "g++ - Build and debug active file",
            "type": "cppdbg",
            "request": "launch",
            "program": path.join(cwd, 'main/main'),
            "args": [JSON.stringify([args]).replace(/"|\\|\s/g, (s) => `\\${s}`)],
            "stopAtEntry": false,
            "cwd": cwd,
            "environment": [],
            "externalConsole": false,
            "MIMode": "gdb",
            "setupCommands": [
                {
                    "description": "Enable pretty-printing for gdb",
                    "text": "-enable-pretty-printing",
                    "ignoreFailures": true
                }
            ],
        }

    }
    shouldRemoveInBuild(line: string): boolean {
        return line.trim().startsWith('package')
    }

}