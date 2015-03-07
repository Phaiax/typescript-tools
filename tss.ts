// Copyright (c) Claus Reinke. All rights reserved.
// Licensed under the Apache License, Version 2.0.
// See LICENSE.txt in the project root for complete license information.

///<reference path='typings/node/node.d.ts'/>
///<reference path='node_modules/typescript/bin/typescript.d.ts'/>
///<reference path='node_modules/typescript/bin/typescript_internal.d.ts'/>

import ts = require("typescript");
import harness = require("./harness");

// __dirname + a file to put path references in.. :-(
declare var __dirname : string;
var defaultLibs  = __dirname + "/defaultLibs.d.ts";

function switchToForwardSlashes(path: string) {
    return path.replace(/\\/g, "/");
}

// some approximated subsets..
interface ReadlineHandlers {
  on(event: string, listener: (event:string)=>void) : ReadlineHandlers;
  close() : void;
}
interface Readline {
  createInterface(options:any) : ReadlineHandlers;
}

// bypass import, we don't want to drop out of the global module;
// use fixed readline (https://github.com/joyent/node/issues/3305),
// fixed version should be in nodejs from about v0.9.9/v0.8.19?
var readline:Readline = require("./readline");

var EOL = require("os").EOL;

/** TypeScript Services Server,
    an interactive commandline tool
    for getting info on .ts projects */
class TSS {
  public compilerOptions: ts.CompilerOptions;
  public compilerHost: ts.CompilerHost;
  public program: ts.Program;
  public fileNames: string[];
  public lsHost : ts.LanguageServiceHost;
  public ls : ts.LanguageService;
  public rootFiles : string[];
//  public resolutionResult : ts.ReferenceResolutionResult;
  public lastError;

  constructor (public prettyJSON: boolean = false) { } // NOTE: call setup

  private fileNameToContent:ts.Map<string>;
  private snapshots:ts.Map<ts.IScriptSnapshot>;
  private fileNameToScript:ts.Map<harness.ScriptInfo>;

  /**
   * @param line 1 based index
   * @param col 1 based index
   */
  public lineColToPosition(fileName: string, line: number, col: number): number {
      var script: harness.ScriptInfo = this.fileNameToScript[fileName];

      return ts.computePositionOfLineAndCharacter(script.lineMap,line-1, col-1);
  }

  /**
   * @returns {line,character} 1 based indices
   */
  private positionToLineCol(fileName: string, position: number): ts.LineAndCharacter {
      var script: harness.ScriptInfo = this.fileNameToScript[fileName];

      var lineChar = ts.computeLineAndCharacterOfPosition(script.lineMap,position);

      return {line: lineChar.line+1, character: lineChar.character+1 };
  }

  /**
   * @param line 1 based index
   */
  private getLineText(fileName,line) {
    var script    = this.fileNameToScript[fileName];
    var lineMap   = script.lineMap;
    var lineStart = ts.computePositionOfLineAndCharacter(lineMap,line-1,0)
    var lineEnd   = ts.computePositionOfLineAndCharacter(lineMap,line,0)-1;
    var lineText  = script.content.substring(lineStart,lineEnd);
    return lineText;
  }

  private updateScript(fileName: string, content: string) {
      var script = this.fileNameToScript[fileName];
      if (script !== undefined) {
        script.updateContent(content);
      } else {
        this.fileNameToScript[fileName] = new harness.ScriptInfo(fileName, content);
      }
      this.snapshots[fileName] = new harness.ScriptSnapshot(this.fileNameToScript[fileName]);
  }

  private editScript(fileName: string, minChar: number, limChar: number, newText: string) {
      var script = this.fileNameToScript[fileName];
      if (script !== undefined) {
          script.editContent(minChar, limChar, newText);
          this.snapshots[fileName] = new harness.ScriptSnapshot(script);
          return;
      }
      throw new Error("No script with name '" + fileName + "'");
  }


  // IReferenceResolverHost methods (from HarnessCompiler, modulo test-specific code)
  getScriptSnapshot(filename: string): ts.IScriptSnapshot {
      var content = this.fileNameToContent[filename];
      if (!content) {
        content = ts.sys.readFile(filename);
        this.fileNameToContent[filename] = content;
      }
      var snapshot = new harness.ScriptSnapshot(new harness.ScriptInfo(filename, content));

/* TODO
      if (!snapshot) {
          this.addDiagnostic(new ts.Diagnostic(null, 0, 0, ts.DiagnosticCode.Cannot_read_file_0_1, [filename, '']));
      }
*/

      return snapshot;
  }

  resolveRelativePath(path: string, directory?: string): string {
      var unQuotedPath = path; // better be.. ts.stripStartAndEndQuotes(path);
      var normalizedPath: string;

      if (ts.isRootedDiskPath(unQuotedPath) || !directory) {
          normalizedPath = unQuotedPath;
      } else {
          normalizedPath = ts.combinePaths(directory, unQuotedPath);
      }

      // get the absolute path
      normalizedPath = ts.sys.resolvePath(normalizedPath);

      // Switch to forward slashes
      normalizedPath = switchToForwardSlashes(normalizedPath)
                           .replace(/^(.:)/,function(_,drive?){return drive.toLowerCase()});

      return normalizedPath;
  }

  fileExists(s: string):boolean {
      return ts.sys.fileExists(s);
  }
  directoryExists(path: string): boolean {
      return ts.sys.directoryExists(path);
  }
//  getParentDirectory(path: string): string {
//      return ts.sys.directoryName(path);
//  }

  public getErrors(): ts.Diagnostic[] {

      var addPhase = phase => d => {d.phase = phase; return d};
      var errors = [];
      ts.forEachKey(this.fileNameToScript, file=>{
        var syntactic = this.ls.getSyntacticDiagnostics(file);
        var semantic = this.ls.getSemanticDiagnostics(file);
        // this.ls.languageService.getEmitOutput(file).diagnostics);
        errors = errors.concat(syntactic.map(addPhase("Syntax"))
                              ,semantic.map(addPhase("Semantics")));
      });
      return errors;

  }

  /** load file and dependencies, prepare language service for queries */
  public setup(files,options) {
    this.rootFiles = files.map(this.resolveRelativePath);

    this.compilerOptions             = options;
    // this.compilerOptions.diagnostics = true;
    // this.compilerOptions.target      = ts.ScriptTarget.ES5;
    // this.compilerOptions.module      = ts.ModuleKind.CommonJS;

    this.fileNameToContent = {};

    // build program from root file,
    // chase dependencies (references and imports), normalize file names, ...
    this.compilerHost = ts.createCompilerHost(this.compilerOptions);
    this.program      = ts.createProgram(this.rootFiles,this.compilerOptions,this.compilerHost);

    this.fileNames        = [];
    this.fileNameToScript = {};
    this.snapshots        = {};
    //TODO: diagnostics

    this.program.getSourceFiles().forEach(source=>{
      var filename = this.resolveRelativePath(source.fileName);
      this.fileNames.push(filename);
      this.fileNameToScript[filename] =
        new harness.ScriptInfo(filename,source.text);
      this.snapshots[filename] = new harness.ScriptSnapshot(this.fileNameToScript[filename]);
    });

    // Get a language service
    this.lsHost = {
        getCompilationSettings : ()=>this.compilerOptions,
        getScriptFileNames : ()=>this.fileNames,
        getScriptVersion : (fileName: string)=>this.fileNameToScript[fileName].version.toString(),
        getScriptIsOpen : (fileName: string)=>this.fileNameToScript[fileName].isOpen,
        getScriptSnapshot : (fileName: string)=>this.snapshots[fileName],
//        getLocalizedDiagnosticMessages?(): any;
//        getCancellationToken : ()=>this.compilerHost.getCancellationToken(),
        getCurrentDirectory : ()=>this.compilerHost.getCurrentDirectory(),
        getDefaultLibFileName :
          (options: ts.CompilerOptions)=>this.compilerHost.getDefaultLibFileName(options),
        log : (message)=>undefined, // ??
        trace : (message)=>undefined, // ??
        error : (message)=>console.error(message) // ??
    };
    this.ls     = ts.createLanguageService(this.lsHost,ts.createDocumentRegistry());

  }

  private output(info,excludes=["displayParts"]) {
    var replacer = (k,v)=>excludes.indexOf(k)!==-1?undefined:v;
    if (info) {
      console.log(JSON.stringify(info,replacer,this.prettyJSON?" ":undefined).trim());
    } else {
      console.log(JSON.stringify(info,replacer));
    }
  }

  private outputJSON(json) {
    console.log(json.trim());
  }

  private handleNavBarItem(file:string,item:ts.NavigationBarItem) {
    // TODO: under which circumstances can item.spans.length be other than 1?
    return { info: [item.kindModifiers,item.kind,item.text].filter(s=>s!=="").join(" ")
           , kindModifiers : item.kindModifiers
           , kind: item.kind
           , text: item.text
           , min: this.positionToLineCol(file,item.spans[0].start)
           , lim: this.positionToLineCol(file,item.spans[0].start+item.spans[0].length)
           , childItems: item.childItems.map(item=>this.handleNavBarItem(file,item))
           };
  }

  /** commandline server main routine: commands in, JSON info out */
  public listen() {
    var line: number;
    var col: number;

    var rl = readline.createInterface({input:process.stdin,output:process.stdout});

    var cmd:string, pos:number, file:string, script, added:boolean, range:boolean, check:boolean
      , def, refs:ts.ReferenceEntry[], locs:ts.DefinitionInfo[], info, source:string
      , brief, member:boolean, navbarItems:ts.NavigationBarItem[], pattern:string;

    var collecting = 0, on_collected_callback:()=>void, lines:string[] = [];

    var commands = {};
    function match(cmd,regexp) {
      commands[regexp.source] = true;
      return cmd.match(regexp);
    }

    rl.on('line', input => {  // most commands are one-liners
      var m:string[];
      try {

        cmd = input.trim();

        if (collecting>0) { // multiline input, eg, source

          lines.push(input)
          collecting--;

          if (collecting===0) {
            on_collected_callback();
          }



        } else if (m = match(cmd,/^(type|quickInfo) (\d+) (\d+) (.*)$/)) { // "type" deprecated

          line   = parseInt(m[2]);
          col    = parseInt(m[3]);
          file   = this.resolveRelativePath(m[4]);

          pos    = this.lineColToPosition(file,line,col);

          info            = (this.ls.getQuickInfoAtPosition(file, pos)||{});
          info.type       = ((info&&ts.displayPartsToString(info.displayParts))||"");
          info.docComment = ((info&&ts.displayPartsToString(info.documentation))||"");

          this.output(info);

        } else if (m = match(cmd,/^definition (\d+) (\d+) (.*)$/)) {

          line = parseInt(m[1]);
          col  = parseInt(m[2]);
          file = this.resolveRelativePath(m[3]);

          pos  = this.lineColToPosition(file,line,col);
          locs = this.ls.getDefinitionAtPosition(file, pos); // NOTE: multiple definitions

          info = locs.map( def => ({
            def  : def,
            file : def && def.fileName,
            min  : def && this.positionToLineCol(def.fileName,def.textSpan.start),
            lim  : def && this.positionToLineCol(def.fileName,ts.textSpanEnd(def.textSpan))
          }));

          // TODO: what about multiple definitions?
          this.output(info[0]||null);

        } else if (m = match(cmd,/^(references|occurrences) (\d+) (\d+) (.*)$/)) {

          line = parseInt(m[2]);
          col  = parseInt(m[3]);
          file = this.resolveRelativePath(m[4]);

          pos  = this.lineColToPosition(file,line,col);
          switch (m[1]) {
            case "references":
              refs = this.ls.getReferencesAtPosition(file, pos);
              break;
            case "occurrences":
              refs = this.ls.getOccurrencesAtPosition(file, pos);
              break;
            default:
              throw "cannot happen";
          }

          info = (refs || []).map( ref => {
            var start, end, fileName, lineText;
            if (ref) {
              start    = this.positionToLineCol(ref.fileName,ref.textSpan.start);
              end      = this.positionToLineCol(ref.fileName,ts.textSpanEnd(ref.textSpan));
              fileName = this.resolveRelativePath(ref.fileName);
              lineText = this.getLineText(fileName,start.line);
            }
            return {
              ref      : ref,
              file     : ref && ref.fileName,
              lineText : lineText,
              min      : start,
              lim      : end
            }} );

          this.output(info);

        } else if (m = match(cmd,/^navigationBarItems (.*)$/)) {

          file = this.resolveRelativePath(m[1]);

          this.output(this.ls.getNavigationBarItems(file)
                          .map(item=>this.handleNavBarItem(file,item)));

        } else if (m = match(cmd,/^navigateToItems (.*)$/)) {

          pattern = m[1];

          info = this.ls.getNavigateToItems(pattern)
                   .map(item=>{
                      item['min'] = this.positionToLineCol(item.fileName
                                                          ,item.textSpan.start);
                      item['lim'] = this.positionToLineCol(item.fileName
                                                          ,item.textSpan.start
                                                          +item.textSpan.length);
                      return item;
                    });

          this.output(info);

        } else if (m = match(cmd,/^completions(-brief)?( true| false)? (\d+) (\d+) (.*)$/)) {

          brief  = m[1];
          line   = parseInt(m[3]);
          col    = parseInt(m[4]);
          file   = this.resolveRelativePath(m[5]);

          pos    = this.lineColToPosition(file,line,col);

          info = this.ls.getCompletionsAtPosition(file, pos) || null;

          if (info) {
            // fill in completion entry details, unless briefness requested
            !brief && (info.entries = info.entries.map( e =>{
                        var d = this.ls.getCompletionEntryDetails(file,pos,e.name);
                        if (d) {
                          d["type"]      =ts.displayPartsToString(d.displayParts);
                          d["docComment"]=ts.displayPartsToString(d.documentation);
                          return d;
                        } else {
                          return e;
                        }} ));
                        // NOTE: details null for primitive type symbols, see TS #1592

            (()=>{ // filter entries by prefix, determined by pos
              var languageVersion = this.compilerOptions.target;
              var source   = this.fileNameToScript[file].content;
              var startPos = pos;
              var idPart   = p => /[0-9a-zA-Z_$]/.test(source[p])
                               || ts.isIdentifierPart(source.charCodeAt(p),languageVersion);
              var idStart  = p => /[a-zA-Z_$]/.test(source[p])
                               || ts.isIdentifierStart(source.charCodeAt(p),languageVersion);
              while ((--startPos>=0) && idPart(startPos) );
              if ((++startPos < pos) && idStart(startPos)) {
                var prefix = source.slice(startPos,pos);
                info["prefix"] = prefix;
                var len    = prefix.length;
                info.entries = info.entries.filter( e => e.name.substr(0,len)===prefix );
              }
            })();
          }

          this.output(info,["displayParts","documentation"]);

        } else if (m = match(cmd,/^update( nocheck)? (\d+)( (\d+)-(\d+))? (.*)$/)) { // send non-saved source

          file       = this.resolveRelativePath(m[6]);
          script     = this.fileNameToScript[file];
          added      = script===undefined;
          range      = !!m[3]
          check      = !m[1]

          // TODO: handle dependency changes

          if (!added || !range) {
            collecting = parseInt(m[2]);
            on_collected_callback = () => {

              if (!range) {
                this.updateScript(file,lines.join(EOL));
              } else {
                var startLine = parseInt(m[4]);
                var endLine   = parseInt(m[5]);
                var maxLines  = script.lineMap.length;
                var startPos  = startLine<=maxLines
                              ? (startLine<1 ? 0 : this.lineColToPosition(file,startLine,1))
                              : script.content.length;
                var endPos    = endLine<maxLines
                              ? (endLine<1 ? 0 : this.lineColToPosition(file,endLine+1,0)-1) //??CHECK
                              : script.content.length;

                this.editScript(file, startPos, endPos, lines.join(EOL));
              }
              var syn:number,sem:number;
              if (check) {
                syn = this.ls.getSyntacticDiagnostics(file).length;
                sem = this.ls.getSemanticDiagnostics(file).length;
              }
              on_collected_callback = undefined;
              lines = [];

              this.outputJSON((added ? '"added ' : '"updated ')
                              +(range ? 'lines'+m[3]+' in ' : '')
                              +file+(check ? ', ('+syn+'/'+sem+') errors' : '')+'"');
            };
          } else {
            this.outputJSON('"cannot update line range in new file"');
          }

        } else if (m = match(cmd,/^showErrors$/)) { // get processing errors

          info = this.program.getGlobalDiagnostics()
                     /*
                     .concat(this.fileNames.map(file=>
                                    this.program.getDiagnostics(this.program.getSourceFile(file)))
                                 .reduce((l,r)=>l.concat(r)))
                     */
                     .concat(this.getErrors())
                     .map( d => {
                           var file = this.resolveRelativePath(d.file.fileName);
                           var lc   = this.positionToLineCol(file,d.start);
                           var len  = this.fileNameToScript[file].content.length;
                           var end  = Math.min(len,d.start+d.length);
                                      // NOTE: clamped to end of file (#11)
                           var lc2  = this.positionToLineCol(file,end);
                           return {
                            file: file,
                            start: {line: lc.line, character: lc.character},
                            end: {line: lc2.line, character: lc2.character},
                            text: /* file+"("+lc.line+"/"+lc.character+"): "+ */ d.messageText,
                            code: d.code,
                            phase: d["phase"],
                            category: ts.DiagnosticCategory[d.category]
                           };
                         }
                       );

          this.output(info);

        } else if (m = match(cmd,/^files$/)) { // list files in project

          info = this.lsHost.getScriptFileNames(); // TODO: files are pre-resolved

          this.output(info);

        } else if (m = match(cmd,/^lastError(Dump)?$/)) { // debugging only

          if (this.lastError)
            if (m[1]) // commandline use
              console.log(JSON.parse(this.lastError).stack);
            else
              this.outputJSON(this.lastError);
          else
            this.outputJSON('"no last error"');

        } else if (m = match(cmd,/^dump (\S+) (.*)$/)) { // debugging only

          var dump = m[1];
          file     = this.resolveRelativePath(m[2]);

          source         = this.fileNameToScript[file].content;
          if (dump==="-") { // to console
            console.log('dumping '+file);
            console.log(source);
          } else { // to file
            ts.sys.writeFile(dump,source,false);

            this.outputJSON('"dumped '+file+' to '+dump+'"');
          }

        } else if (m = match(cmd,/^reload$/)) { // reload current project

          // TODO: keep updated (in-memory-only) files?
          this.setup(this.rootFiles,this.compilerOptions);
          this.outputJSON('"reloaded '+this.rootFiles[0]+' and '+(this.rootFiles.length-1)+' more, TSS listening.."');

        } else if (m = match(cmd,/^quit$/)) {

          rl.close();

        } else if (m = match(cmd,/^prettyJSON (true|false)$/)) {

          this.prettyJSON = m[1]==='true';

          this.outputJSON('"pretty JSON: '+this.prettyJSON+'"');

        } else if (m = match(cmd,/^help$/)) {

          console.log(Object.keys(commands).join(EOL));

        } else {

          this.outputJSON('"TSS command syntax error: '+cmd+'"');

        }

      } catch(e) {

          this.lastError = (JSON.stringify({msg:e.toString(),stack:e.stack})).trim();
          this.outputJSON('"TSS command processing error: '+e+'"');

      }

    }).on('close', () => {

          this.outputJSON('"TSS closing"');

    });

    this.outputJSON('"loaded '+this.rootFiles[0]+' and '+(this.rootFiles.length-1)+' more, TSS listening.."');

  }
}

// from src/compiler/tsc.ts - not yet exported from there:-(
function findConfigFile(): string {
  var searchPath = ts.normalizePath(ts.sys.getCurrentDirectory());
  var filename = "tsconfig.json";

  while (true) {
     if (ts.sys.fileExists(filename)) { return filename; }

     var parentPath = ts.getDirectoryPath(searchPath);

     if (parentPath === searchPath) { break; }

     searchPath = parentPath;

     filename = "../" + filename;
  }

  return undefined;
}

var arg;
var configFile, configObject, configObjectParsed;

// NOTE: partial options support only
var commandLine = ts.parseCommandLine(ts.sys.args);

if (commandLine.options.version) {
  console.log(require("../package.json").version);
  process.exit(0);
}

if (commandLine.options.project) {

  configFile = ts.normalizePath(ts.combinePaths(commandLine.options.project,"tsconfig.json"));

} else if (commandLine.fileNames.length===0) {

  configFile = findConfigFile();
  if (!configFile) {
    console.error("can't find project root");
    console.error("please specify root source file");
    console.error("  or --project directory (containing a tsconfig.json)");
    process.exit(1);
  }
}

var options;

if (configFile) {
  configObject = ts.readConfigFile(configFile);
  if (!configObject) {
    console.error("can't read tsconfig.json at",configFile);
    process.exit(1);
  }
  configObjectParsed = ts.parseConfigFile(configObject,ts.getDirectoryPath(configFile));
  if (configObjectParsed.errors.length>0) {
    console.error(configObjectParsed.errors);
    process.exit(1);
  }
  options = ts.extend(commandLine.options,configObjectParsed.options);
} else {
  options = ts.extend(commandLine.options,ts.getDefaultCompilerOptions());
}

var tss = new TSS();
tss.setup([commandLine.fileNames[0]],options);
tss.listen();
